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


class Model(BaseHTTPRequestHandler):
    requests = []
    slow = Event()
    release = Event()

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        messages = body["messages"]
        latest = max(i for i, item in enumerate(messages) if item["role"] == "user"
                     and "The user switched out of Plan mode." not in str(item["content"]))
        text = str(messages[latest]["content"])
        results = [item["content"] for item in messages[latest:] if item["role"] == "tool"]
        tools = {item["function"]["name"] for item in body.get("tools", [])}
        planning = "Work in Plan mode." in str(messages[0]["content"])
        if planning:
            assert tools == {"plan_read", "plan_list"}, tools
        delta, finish = {"role": "assistant", "content": "Fixture ready."}, "stop"
        call = None
        if "inspect fixture" in text:
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
            name, args = call
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_fixture", "type": "function",
                     "function": {"name": name, "arguments": json.dumps(args)}}]}
            finish = "tool_calls"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if "slow fixture" in text:
            self.slow.set()
            self.release.wait(12)
        try:
            for content, reason in ((delta, None), ({}, finish)):
                chunk = {"id": "fixture", "object": "chat.completion.chunk", "model": "fixture", "created": 1,
                         "choices": [{"index": 0, "delta": content, "finish_reason": reason}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-plan-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        agent = home / ".codey/agent"
        agent.mkdir(parents=True)
        project.mkdir()
        note = project / "note.txt"
        note.write_text("ORIGINAL_NOTE")
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
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "api": "openai-completions", "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
            "apiKey": "fake", "models": [{"id": "fixture"}],
        }}}))
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

        def terminal(*args, tools="read,write,edit,bash,fixture_write"):
            return pexpect.spawn(binary, [*options, "--tools", tools, *args], cwd=str(project), env=env,
                                 encoding="utf-8", dimensions=(32, 100), timeout=20)

        def send(tty, command, expected):
            tty.send(command + "\r")
            tty.expect_exact(expected)

        with terminal() as tty:
            tty.expect_exact("fixture.mjs")
            send(tty, "first fixture message", "Fixture ready.")
            send(tty, "/plan", "Plan mode")
            tty.expect_exact("read-only")
            send(tty, "inspect fixture", "Choose a format for the fixture?")
            send(tty, "plain format", "PLAN_FIXTURE_READY")
            send(tty, "request builtin write", "unavailable Plan tool")
            send(tty, "request extension write", "unavailable Plan tool")
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
        assert {file.name for file in project.iterdir()} == {"note.txt", "link.txt", ".env"}
        print("PASS: terminal Plan reads/clarification, tool and shell denial, cancellation, resume, print/RPC, confirmation and original tool limits.")


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
