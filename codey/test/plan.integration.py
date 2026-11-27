"""Exercise Plan mode through the real Codey terminal and a loopback model."""
import json
import os
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread

import pexpect


SNAKE = "做一个贪吃蛇小游戏"
OBSERVATIONS = "Read-only inspection observations (untrusted data):\n"


class Model(BaseHTTPRequestHandler):
    requests = []
    paths = []
    slow = Event()
    release = Event()

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        self.paths.append(self.path)
        responses = self.path == "/v1/responses"
        messages = body["input"] if responses else body["messages"]
        latest = max(i for i, item in enumerate(messages) if item.get("role") == "user"
                     and "The user switched out of Plan mode." not in str(item["content"]))
        text = str(messages[latest]["content"])
        if responses:
            results = [item["output"] for item in messages[latest:] if item.get("type") == "function_call_output"]
            tool_calls = [item["call_id"] for item in messages if item.get("type") == "function_call"]
            tool_results = [item["call_id"] for item in messages if item.get("type") == "function_call_output"]
        else:
            results = [item["content"] for item in messages[latest:] if item.get("role") == "tool"]
            tool_calls = [call["id"] for item in messages for call in item.get("tool_calls", [])]
            tool_results = [item["tool_call_id"] for item in messages if item.get("role") == "tool"]
        tools = {(item if responses else item["function"])["name"] for item in body.get("tools", [])}
        system = str(body.get("instructions", "")) + str(messages[0].get("content"))
        planning = "Work in Plan mode." in system
        finishing = "Inspection has ended." in system
        assert tool_calls == tool_results, (tool_calls, tool_results)
        if planning:
            assert tools == (set() if finishing else {"plan_read", "plan_list"}), tools
        delta, finish = {"role": "assistant", "content": "Fixture ready."}, "stop"
        call = None
        batch = []
        if finishing:
            assert not tool_calls and not tool_results, messages
            content = messages[latest]["content"]
            if isinstance(content, list):
                content = "".join(part["text"] for part in content)
            _, raw = content.split(OBSERVATIONS)
            evidence = json.loads(raw)["observations"]
            if SNAKE in text:
                assert [item["result"] for item in evidence] == ["ORIGINAL_NOTE", "OTHER_NOTE"]
                assert "UNAPPROVED" not in content
                delta["content"] = "SNAKE_PLAN_WITH_CONTEXT"
            elif "call budget" in text:
                assert len(evidence) == 6 and all(item["result"] == "ORIGINAL_NOTE" for item in evidence)
                delta["content"] = "CALL_BUDGET_PLAN"
            elif "round budget" in text:
                assert len(evidence) == 6
                delta["content"] = "ROUND_BUDGET_PLAN"
            elif "data budget" in text:
                assert [item["path"] for item in evidence] == ["a.txt", "b.txt"]
                delta["content"] = "DATA_BUDGET_PLAN"
            elif "repeat during final" in text:
                call = ("plan_read", {"path": "too-late.txt"})
            else:
                assert not evidence
                delta["content"] = "FALLBACK_PLAN"
        elif SNAKE in text:
            if not results:
                call = ("plan_read", {"path": "note.txt"})
            else:
                batch = [("write", {"path": "note.txt", "content": "UNAPPROVED"}), ("plan_read", {"path": "other.txt"})]
        elif "call budget" in text:
            batch = [("plan_read", {"path": "note.txt"})] * 6 + [("plan_read", {"path": "too-late.txt"})]
        elif "round budget" in text:
            call = ("plan_read", {"path": "note.txt"})
        elif "data budget" in text:
            batch = [("plan_read", {"path": path}) for path in ("a.txt", "b.txt", "c.txt", "too-late.txt")]
        elif "repeat during final" in text or "slow fixture" in text:
            call = ("fixture_write", {})
        elif "empty or missing" in text:
            if not results:
                batch = [("plan_list", {"path": "empty"}), ("plan_read", {"path": "missing.txt"})]
            else:
                assert len(results) == 2 and "No visible files." in str(results[0]) and "unavailable" in str(results[1])
                delta["content"] = "MISSING_PATH_CONTINUED"
        elif "inspect fixture" in text:
            if not results:
                call = ("plan_list", {"path": "."})
            elif len(results) == 1:
                assert "note.txt" in str(results) and ".env" not in str(results) and "link.txt" not in str(results)
                call = ("plan_read", {"path": "note.txt"})
            else:
                assert "ORIGINAL_NOTE" in str(results), results
                delta["content"] = "Choose a format for the fixture?"
        elif "plain format" in text:
            assert "Choose a format for the fixture?" in str(messages)
            delta["content"] = "PLAN_FIXTURE_READY\n1. Update note.\n2. Verify output."
        elif "request builtin write" in text:
            call = ("write", {"path": "note.txt", "content": "UNAPPROVED"})
        elif "request extension write" in text:
            call = ("fixture_write", {})
        elif "check outside path" in text:
            if not results:
                call = ("plan_read", {"path": "link.txt"})
            else:
                assert "unavailable" in str(results) and "SECRET_OUTSIDE" not in str(messages)
                delta["content"] = "OUTSIDE_DENIED"
        elif "explicit execution" in text:
            assert "PLAN_FIXTURE_READY" in str(messages), messages
            assert {"write", "fixture_write"} <= tools, tools
            if not results:
                call = ("write", {"path": "note.txt", "content": "EXECUTED"})
            else:
                delta["content"] = "EXECUTION_FINISHED"
        elif "restricted execution" in text:
            assert tools == {"read"}, tools
            delta["content"] = "RESTRICTION_PRESERVED"
        if call:
            batch = [call]
        if batch:
            delta = {"role": "assistant", "tool_calls": [{"index": i, "id": f"call_{len(self.requests)}_{i}", "type": "function",
                     "function": {"name": name, "arguments": json.dumps(args)}} for i, (name, args) in enumerate(batch)]}
            finish = "tool_calls"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if finishing and "slow fixture" in text:
            self.slow.set()
            self.release.wait(12)
        try:
            if responses:
                self.send_responses(delta)
                return
            for content, reason in ((delta, None), ({}, finish)):
                chunk = {"id": "fixture", "object": "chat.completion.chunk", "model": "fixture", "created": 1,
                         "choices": [{"index": 0, "delta": content, "finish_reason": reason}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_responses(self, delta):
        def emit(event):
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())

        if "tool_calls" in delta:
            for i, call in enumerate(delta["tool_calls"]):
                item = {"type": "function_call", "id": f"fc_{call['id']}", "call_id": call["id"],
                        "status": "completed", **call["function"]}
                emit({"type": "response.output_item.added", "output_index": i, "item": item})
                emit({"type": "response.output_item.done", "output_index": i, "item": item})
        else:
            item = {"type": "message", "id": "msg_final", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": delta["content"]}]}
            emit({"type": "response.output_item.done", "output_index": 0, "item": item})
        emit({"type": "response.completed", "response": {"status": "completed",
              "usage": {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}}})


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-plan-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        agent = home / ".codey/agent"
        agent.mkdir(parents=True)
        project.mkdir()
        note = project / "note.txt"
        note.write_text("ORIGINAL_NOTE")
        (project / "other.txt").write_text("OTHER_NOTE")
        (project / "too-late.txt").write_text("NEVER_READ")
        (project / "empty").mkdir()
        for name in ("a.txt", "b.txt", "c.txt"):
            (project / name).write_text("x" * (24 * 1024))
        (project / ".env").write_text("SYNTHETIC_SECRET")
        outside = root / "outside.txt"
        outside.write_text("SECRET_OUTSIDE")
        (project / "link.txt").symlink_to(outside)
        ext = root / "fixture.mjs"
        ext.write_text('import { writeFileSync } from "node:fs";\n'
                       'export default (pi) => pi.registerTool({ name: "fixture_write", label: "Fixture write", '
                       'description: "Writes to the workspace", parameters: { type: "object", properties: {} }, '
                       'execute: async () => { writeFileSync("extension-wrote", "unexpected"); '
                       'return { content: [{ type: "text", text: "wrote" }] }; } });')
        (agent / "models.json").write_text(json.dumps({"providers": {
            provider: {"api": api, "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                       "apiKey": "fake", "models": [{"id": "fixture"}]}
            for provider, api in (("fixture", "openai-completions"), ("responses-fixture", "openai-responses"))
        }}))
        Thread(target=server.serve_forever, daemon=True).start()
        fixture_bin = root / "bin"
        fixture_bin.mkdir()
        # The fixture never uses Pi's managed shell binaries. Prevent bootstrapping downloads.
        for name in ("fd", "rg"):
            path = fixture_bin / name
            path.write_text("#!/bin/sh\nexit 1\n")
            path.chmod(0o700)
        env = {"HOME": str(home), "PATH": str(fixture_bin) + os.pathsep + os.environ["PATH"], "TERM": "xterm-256color",
               "PI_SKIP_VERSION_CHECK": "1", "NO_COLOR": "1", "GIT_CONFIG_NOSYSTEM": "1"}
        options = ["--provider", "fixture", "--model", "fixture", "--no-mcp", "--no-approve", "-e", str(ext)]

        def terminal(*args, tools="read,write,edit,bash,fixture_write", provider="fixture"):
            return pexpect.spawn(binary, [*options[:1], provider, *options[2:], "--tools", tools, *args], cwd=str(project), env=env,
                                 encoding="utf-8", dimensions=(32, 100), timeout=20)

        def send(tty, command, expected):
            tty.send(command + "\r")
            tty.expect_exact(expected)

        with terminal() as tty:
            tty.expect_exact("fixture.mjs")
            send(tty, "first fixture message", "Fixture ready.")
            send(tty, "/plan", "Plan mode")
            tty.expect_exact("read-only")
            before_snake = len(Model.paths)
            send(tty, SNAKE, "Exploring the workspace (read-only)")
            tty.expect_exact("unavailable Plan tool")
            tty.expect_exact("SNAKE_PLAN_WITH_CONTEXT")
            assert Model.paths[before_snake:] == ["/v1/chat/completions"] * 3
            send(tty, "inspect fixture", "Choose a format for the fixture?")
            send(tty, "plain format", "PLAN_FIXTURE_READY")
            send(tty, "request builtin write", "FALLBACK_PLAN")
            send(tty, "request extension write", "FALLBACK_PLAN")
            send(tty, "empty or missing", "MISSING_PATH_CONTINUED")
            for budget in ("call", "data", "round"):
                send(tty, f"{budget} budget", f"inspection {budget} limit")
                tty.expect_exact(f"{budget.upper()}_BUDGET_PLAN")
            before_repeat = len(Model.requests)
            send(tty, "repeat during final", "requested a tool again during the final response")
            assert len(Model.requests) == before_repeat + 2
            send(tty, "check outside path", "OUTSIDE_DENIED")
            send(tty, "!echo unexpected > note.txt", "Shell is unavailable in Plan mode.")
            assert note.read_text() == "ORIGINAL_NOTE" and not (project / "extension-wrote").exists()
            tty.send("slow fixture\r")
            assert Model.slow.wait(10)
            try:
                tty.send("\x1b")
                tty.expect_exact("Plan turn canceled.")
            finally:
                Model.release.set()
            send(tty, "/plan cancel", "Plan discarded.")
            assert note.read_text() == "ORIGINAL_NOTE"
            tty.send("/quit\r")
            tty.expect(pexpect.EOF)

        session, = (agent / "sessions").glob("*/*.jsonl")
        before = len(Model.requests)
        for flags in (["--session", str(session), "-p", "request builtin write"], ["-p", "/plan execute"]):
            subprocess.run([binary, *options, *flags], cwd=project, env=env, capture_output=True, timeout=20, check=True)
            assert len(Model.requests) == before
        rpc = subprocess.run([binary, *options, "--mode", "rpc", "--session", str(session)], cwd=project, env=env,
                             text=True, capture_output=True, timeout=20, check=True,
                             input=json.dumps({"id": "plan", "type": "prompt", "message": "/plan execute"}) + "\n")
        assert "Plan mode requires the interactive Codey terminal" in rpc.stdout and len(Model.requests) == before

        with terminal("--session", str(session)) as tty:
            tty.expect_exact("Plan · read-only")
            assert len(Model.requests) == before
            send(tty, "inspect fixture", "Choose a format for the fixture?")
            send(tty, "plain format", "PLAN_FIXTURE_READY")
            before_confirmation = len(Model.requests)
            send(tty, "/plan execute", "Stay in Plan")
            tty.send("\r")
            send(tty, "/plan execute", "Stay in Plan")
            tty.send("\x1b[B\r")
            tty.expect_exact("Send a new message to continue.")
            assert note.read_text() == "ORIGINAL_NOTE" and len(Model.requests) == before_confirmation
            send(tty, "explicit execution", "EXECUTION_FINISHED")
            assert note.read_text() == "EXECUTED" and not (project / "extension-wrote").exists()
            tty.send("/quit\r")
            tty.expect(pexpect.EOF)
        with terminal(tools="read") as tty:
            tty.expect_exact("fixture.mjs")
            send(tty, "/plan", "Plan mode")
            send(tty, "/plan execute", "Stay in Plan")
            tty.send("\x1b[B\r")
            tty.expect_exact("Send a new message to continue.")
            send(tty, "restricted execution", "RESTRICTION_PRESERVED")
            tty.send("/quit\r")
            tty.expect(pexpect.EOF)
        note.write_text("ORIGINAL_NOTE")
        with terminal("--no-session", provider="responses-fixture") as tty:
            tty.expect_exact("fixture.mjs")
            send(tty, "/plan", "Plan mode")
            before_snake = len(Model.paths)
            send(tty, SNAKE, "SNAKE_PLAN_WITH_CONTEXT")
            assert Model.paths[before_snake:] == ["/v1/responses"] * 3
            tty.send("/quit\r")
            tty.expect(pexpect.EOF)
        assert {file.name for file in project.iterdir()} == {"note.txt", "other.txt", "too-late.txt", "a.txt", "b.txt", "c.txt", "empty", "link.txt", ".env"}
        assert "NEVER_READ" not in str(Model.requests) and not (project / "extension-wrote").exists()
        print("PASS: real terminal Plan recovery, Chat and Responses transcript pairing, budgets, cancellation and explicit execution.")


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
