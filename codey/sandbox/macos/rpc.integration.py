"""Exercise Codey's actual JSONL pipes and Apple Seatbelt with a synthetic T3 workspace."""

import json
import os
from pathlib import Path
from queue import Empty, Queue
import shlex
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread


class Model(BaseHTTPRequestHandler):
    requests = []
    probes = 0
    release = Event()
    shell = ""

    def log_message(self, *args):
        pass

    def do_GET(self):
        Model.probes += 1
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        latest = max(i for i, item in enumerate(body["messages"]) if item["role"] == "user")
        message = str(body["messages"][latest]["content"])
        tools = [item for item in body["messages"][latest:] if item["role"] == "tool"]
        delta, finish = {"role": "assistant", "content": "STREAM_OK"}, "stop"
        if "boundary fixture" in message and not tools:
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "type": "function", "id": "shell_fixture",
                     "function": {"name": "bash", "arguments": json.dumps({"command": self.shell})}}]}
            finish = "tool_calls"
        elif "boundary fixture" in message:
            assert "BOUNDARY_OK" in str(tools[-1]["content"]), tools
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def emit(content, reason):
            msg = {"id": "rpc-fixture", "object": "chat.completion.chunk", "created": 1, "model": body["model"],
                   "choices": [{"index": 0, "delta": content, "finish_reason": reason}]}
            self.wfile.write(f"data: {json.dumps(msg)}\n\n".encode())
            self.wfile.flush()

        try:
            if "slow fixture" in message:
                emit({"role": "assistant", "content": "SLOW_STARTED"}, None)
                self.release.wait(20)
            else:
                emit(delta, None)
            emit({}, finish)
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


class Rpc:
    def __init__(self, binary, args, cwd, env):
        self.frames = Queue()
        self.seen = []
        self.next_id = 0
        self.process = subprocess.Popen([binary, *args], cwd=cwd, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        Thread(target=self.receive, daemon=True).start()

    def receive(self):
        for line in self.process.stdout:
            try:
                self.frames.put(json.loads(line))
            except ValueError:
                self.frames.put(line)
        self.frames.put(None)

    def send(self, data):
        self.process.stdin.write(data if isinstance(data, bytes) else (json.dumps(data) + "\n").encode())
        self.process.stdin.flush()

    def until(self, predicate):
        while True:
            try:
                frame = self.frames.get(timeout=24)
            except Empty:
                raise AssertionError(self.seen[-8:]) from None
            if frame is None:
                raise AssertionError(self.process.stderr.read().decode())
            assert isinstance(frame, dict), frame
            self.seen.append(frame)
            if predicate(frame):
                return frame

    def request(self, command, *, succeeds=True, **fields):
        self.next_id += 1
        request_id = str(self.next_id)
        self.send({"id": request_id, "type": command, **fields})
        response = self.until(lambda frame: frame.get("id") == request_id)
        assert response["type"] == "response" and response["command"] == command and response["success"] == succeeds, response
        return response.get("data")

    def __enter__(self):
        return self

    def __exit__(self, kind, _err, _traceback):
        self.process.stdin.close()
        try:
            code = self.process.wait(timeout=12)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
            if not kind:
                raise
        else:
            if not kind:
                assert code == 0, self.process.stderr.read().decode()


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-sandbox-rpc-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
        root = Path(temp).resolve()
        home, project, other = (root / name for name in ("home", "project", "other"))
        for path in (home, project, other):
            path.mkdir()
        outside = other / "marker"
        outside.write_text("outside fixture")
        marker = project / ".env"
        marker.write_text("protected fixture")
        extension_marker = project / "extension-loaded"
        extension = root / "pi-t3-mcp-extension.ts"
        extension.write_text(f'import {{ writeFileSync }} from "node:fs"; writeFileSync({json.dumps(str(extension_marker))}, "loaded");')
        alias = root / "codey-t3"
        alias.symlink_to(binary)
        agent = home / ".codey/agent"
        agent.mkdir(parents=True)
        endpoint = f"http://127.0.0.1:{server.server_port}"
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "api": "openai-completions", "apiKey": "synthetic-rpc-key", "baseUrl": endpoint + "/v1",
            "models": [{"id": "fixture-one"}, {"id": "fixture-two", "headers": {"X-Fixture": "synthetic-private-header"}}]
        }}}))
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "PI_SKIP_VERSION_CHECK": "1"}
        Thread(target=server.serve_forever, daemon=True).start()
        subprocess.run(["/usr/bin/curl", "--silent", "--noproxy", "*", endpoint + "/probe"], check=True, env=env)
        assert Model.probes == 1 and outside.read_text() == "outside fixture"
        Model.shell = (f"if /bin/cat {shlex.quote(str(outside))}; then exit 4; fi; "
                       f"if /bin/echo bad >> {shlex.quote(str(outside))}; then exit 4; fi; "
                       "if /bin/cat .env; then exit 4; fi; "
                       f"if /usr/bin/curl --silent --noproxy '*' --max-time 2 {endpoint}/probe; then exit 4; fi; "
                       "/bin/echo allowed > sandbox-output; /bin/echo BOUNDARY_OK")

        flags = ["--mode", "rpc", "--sandbox=workspace-write"]
        # T3 v0.1.11 has a standalone version probe, ephemeral discovery and a separate persistent turn process.
        version = subprocess.check_output([alias, "--version"], env=env, text=True).strip()
        assert version == subprocess.check_output([binary, "--pi-version"], env=env, text=True).strip()
        with Rpc(alias, [*flags, "--no-session", "--offline", "--no-approve", "--no-extensions", "--no-tools"], project, env) as probe:
            assert "sessionFile" not in probe.request("get_state")
            models = probe.request("get_available_models")["models"]
            assert {model["id"] for model in models} == {"fixture-one", "fixture-two"}
            assert all("headers" not in model and "baseUrl" not in model for model in models)
            assert probe.request("get_commands") == {"commands": []}

        with Rpc(alias, [*flags, "--extension", str(extension)], project, env) as rpc:
            session_path = Path(rpc.request("get_state")["sessionFile"])
            assert session_path.is_relative_to(agent / "sandbox-rpc")
            assert rpc.request("set_model", provider="fixture", modelId="fixture-two")["id"] == "fixture-two"
            rpc.request("set_session_name", name="Fixture thread")
            rpc.request("set_thinking_level", level="off")
            assert "off" in rpc.request("get_available_thinking_levels")["levels"]
            rpc.send(b"{bad json\n" + b"a" * (257 * 1024) + b"\n" + b"\xff\n")
            for _ in range(3):
                failure = rpc.until(lambda frame: frame.get("command") == "parse")
                assert not failure["success"]
            for name, params in [("bash", {"command": "echo nope"}), ("compact", {}), ("fork", {"entryId": "x"}),
                                 ("switch_session", {"sessionPath": str(outside)}), ("get_state", {"cwd": str(other)}),
                                 ("new_session", {"parentSession": str(outside)}),
                                 ("prompt", {"message": "bad attachment", "images": []}),
                                 ("prompt", {"message": "/review"}), ("prompt", {"message": "!echo nope"})]:
                rpc.request(name, succeeds=False, **params)
            assert not Model.requests
            assert rpc.request("prompt", message="boundary fixture", streamingBehavior="steer") == {"disposition": "started"}
            rpc.until(lambda frame: frame.get("type") == "agent_settled")
            assert any(frame.get("assistantMessageEvent", {}).get("delta") == "STREAM_OK" for frame in rpc.seen)
            assert any(frame.get("type") == "tool_execution_end" for frame in rpc.seen)
            assert (project / "sandbox-output").read_text() == "allowed\n"
            assert Model.probes == 1 and outside.read_text() == "outside fixture" and not extension_marker.exists()
            assert marker.read_text() == "protected fixture"
            names = {entry["function"]["name"] for entry in Model.requests[0]["tools"]}
            assert names == {"read", "write", "edit", "ls", "bash"}, names
            assert Model.requests[0]["model"] == "fixture-two"
            entries = rpc.request("get_entries")
            assert entries["leafId"] and session_path.exists() and session_path.stat().st_mode & 0o077 == 0
            rpc.request("prompt", message="slow fixture")
            rpc.until(lambda frame: frame.get("assistantMessageEvent", {}).get("delta") == "SLOW_STARTED")
            first = len(rpc.seen)
            rpc.request("abort")
            assert any(frame.get("type") == "agent_settled" and frame.get("aborted") for frame in rpc.seen[first:])
            assert not rpc.request("get_state")["isStreaming"]
            Model.release.set()
            rpc.request("new_session")
            assert rpc.request("get_state")["sessionFile"] != str(session_path)
            rpc.request("switch_session", sessionPath=str(session_path))
            assert rpc.request("get_entries")["leafId"]
        print("PASS: real T3-shaped JSONL discovery, sessions, model selection, tools, streamed events and abort; refused unsupported frames and blocked worker network, external writes and protected reads.", flush=True)

        with Rpc(binary, [*flags, "--session", str(session_path)], project, env) as rpc:
            assert rpc.request("get_state")["sessionFile"] == str(session_path)
            assert rpc.request("get_messages")["messages"]
            Model.release.clear()
            rpc.request("prompt", message="slow fixture")
            rpc.until(lambda frame: frame.get("assistantMessageEvent", {}).get("delta") == "SLOW_STARTED")
        Model.release.set()
        with Rpc(binary, [*flags, "--session", str(session_path)], project, env) as reopened:
            assert not reopened.request("get_state")["isStreaming"]
        cross = subprocess.run([binary, *flags, "--session", str(session_path)], cwd=other,
                               env=env, input="", capture_output=True, text=True, timeout=20)
        assert cross.returncode == 1 and not cross.stdout and "from this workspace" in cross.stderr, cross
        failed = subprocess.run([binary, *flags, "--workspace", str(home)], cwd=project,
                                env=env, input="", capture_output=True, text=True, timeout=20)
        assert failed.returncode == 1 and not failed.stdout and "Choose a workspace" in failed.stderr, failed
        print("PASS: EOF aborted an active prompt and released its session; same-workspace reopen works and cross-workspace startup fails closed.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
