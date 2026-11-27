"""Exercise question and answer handling through the installed Codey entry point."""
import json
import os
import runpy
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pexpect


QUESTION = {"id": "format", "question": "Which output format?", "options": [
    {"id": "markdown", "title": "Markdown", "description": "Readable text", "recommended": True},
    {"id": "json", "title": "JSON", "description": "Machine-readable text"},
]}


class Model(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        messages = body["messages"]
        latest = max(i for i, item in enumerate(messages) if item["role"] == "user")
        text = str(messages[latest]["content"])
        tools = {item["function"]["name"] for item in body.get("tools", [])}
        if "Work in Plan mode." in str(messages[0]["content"]):
            assert tools == {"plan_read", "plan_list", "ask_user"}, tools
        assert "ask_user" in tools
        results = [item["content"] for item in messages[latest:] if item["role"] == "tool"]
        finish = "stop"
        if results:
            assert len(results) == 1
            result = json.loads(results[0])
            expected = {"kind": "custom", "text": "CSV please"} if "custom fixture" in text else {"kind": "option", "optionId": "markdown"}
            assert result == {"status": "answered", "questionId": "format", "answer": expected}
            delta = {"content": "CUSTOM_ANSWER_CONFIRMED" if "custom fixture" in text else "OPTION_ANSWER_CONFIRMED"}
        else:
            question = json.loads(json.dumps(QUESTION))
            if "duplicate id" in text:
                question["options"][1]["id"] = question["options"][0]["id"]
            if "control char" in text:
                question["question"] += "\x1b[31m"
            if "oversize question" in text:
                question["question"] = "x" * 161
            calls = [("ask_user", question)]
            if "mixed fixture" in text:
                calls.insert(0, ("write", {"path": "unexpected.txt", "content": "never write"}))
            if "parallel questions" in text:
                calls.append(("ask_user", question))
            delta = {"role": "assistant", "tool_calls": [{"index": i, "id": f"call_{len(self.requests)}_{i}", "type": "function",
                     "function": {"name": name, "arguments": json.dumps(args)}} for i, (name, args) in enumerate(calls)]}
            finish = "tool_calls"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for chunk, reason in ((delta, None), ({}, finish)):
            event = {"id": "question-fixture", "object": "chat.completion.chunk", "model": "fixture", "created": 1,
                     "choices": [{"index": 0, "delta": chunk, "finish_reason": reason}]}
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


def run(binary):
    rpc = runpy.run_path(str(Path(__file__).resolve().parents[1] / "sandbox/macos/rpc.integration.py"))["Rpc"]
    with tempfile.TemporaryDirectory(prefix="codey-ask-user-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
        root = Path(temp).resolve()
        home, project, tool_bins = (root / name for name in ("home", "project", "bin"))
        for directory in (home, project, tool_bins):
            directory.mkdir()
        agent = home / ".codey/agent"
        agent.mkdir(parents=True)
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "api": "openai-completions", "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
            "apiKey": "synthetic", "models": [{"id": "fixture"}],
        }}}))
        # The test does not use Pi's optional managed shell tools.
        for name in ("fd", "rg"):
            tool = tool_bins / name
            tool.write_text("#!/bin/sh\nexit 1\n")
            tool.chmod(0o700)
        Thread(target=server.serve_forever, daemon=True).start()
        env = {"HOME": str(home), "PATH": str(tool_bins) + os.pathsep + os.environ["PATH"],
               "TERM": "xterm-256color", "NO_COLOR": "1", "PI_SKIP_VERSION_CHECK": "1"}
        flags = ["--no-session", "--no-mcp", "--no-approve", "--provider", "fixture", "--model", "fixture"]

        def send(tty, data, expected):
            tty.send(data + "\r")
            tty.expect_exact(expected)

        for plan in (False, True):
            with pexpect.spawn(binary, flags, cwd=str(project), env=env, encoding="utf-8", timeout=24, dimensions=(38, 136)) as tty:
                tty.expect_exact("Ask a question or describe a change.")
                if plan:
                    send(tty, "/plan", "Plan mode")
                before = len(Model.requests)
                send(tty, "option fixture", "Question from the model")
                tty.expect_exact("Markdown [Recommended] — Readable text")
                tty.send("\x1b[B\r")
                tty.expect_exact("Confirm answer")
                assert len(Model.requests) == before + 1, (plan, [request["messages"][-1] for request in Model.requests[before:]])
                tty.send("\x1b[B\r")
                tty.expect_exact("OPTION_ANSWER_CONFIRMED")
                assert len(Model.requests) == before + 2
                send(tty, "custom fixture", "Write a custom answer")
                tty.send("\x1b[B" * 3 + "\r")
                tty.expect_exact("Your answer")
                send(tty, "CSV please", "Confirm answer")
                tty.send("\x1b[B\r")
                tty.expect_exact("CUSTOM_ANSWER_CONFIRMED")
                before = len(Model.requests)
                send(tty, "cancel fixture", "Question from the model")
                tty.send("\x1b[B\r")
                tty.expect_exact("Confirm answer")
                tty.send("\r")  # The default at confirmation is cancel.
                tty.expect_exact("Question canceled.")
                assert len(Model.requests) == before + 1, (plan, [request["messages"][-1] for request in Model.requests[before:]])
                for bad in ("duplicate id", "mixed fixture"):
                    before = len(Model.requests)
                    expected = "No action was taken." if bad in ("mixed fixture", "parallel questions") else "invalid question"
                    send(tty, bad, expected)
                    assert len(Model.requests) == before + 1, (plan, bad, [request["messages"][-1] for request in Model.requests[before:]])
                assert not list(project.iterdir())
                tty.send("/quit\r")
                tty.expect(pexpect.EOF)

        before = len(Model.requests)
        for mode, prompt, expected in (
            ([], "headless fixture", "Markdown [Recommended]"),
            (["--mode", "json"], "headless fixture", "Reply with a choice"),
            ([], "control char", "invalid question"),
            ([], "oversize question", "invalid question"),
            ([], "parallel questions", "No action was taken."),
        ):
            result = subprocess.run([binary, *flags, *mode, "-p", prompt], cwd=project, env=env,
                                    text=True, capture_output=True, check=True, timeout=24)
            assert expected in result.stdout, (prompt, result.stdout, result.stderr)
        assert len(Model.requests) == before + 5
        with rpc(binary, [*flags, "--mode", "rpc"], project, env) as client:
            client.request("prompt", message="rpc fixture")
            client.until(lambda frame: frame.get("type") == "message_end" and "Reply with a choice" in str(frame))
            client.until(lambda frame: frame.get("type") == "agent_end")
            assert not any(frame.get("type") == "extension_ui_request" and frame.get("method") in ("input", "select") for frame in client.seen)
        assert len(Model.requests) == before + 6 and not list(project.iterdir())
    print("PASS: terminal and Plan questions, confirmed choices and custom answers, cancellation, batch and validation guards, print and RPC text fallback.")


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
