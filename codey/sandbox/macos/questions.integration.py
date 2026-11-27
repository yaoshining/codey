"""Test installed Seatbelt terminal, Pi RPC, and ACP form and text paths."""
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

here = Path(__file__).resolve().parent
Rpc = runpy.run_path(str(here / "rpc.integration.py"))["Rpc"]
Acp = runpy.run_path(str(here / "acp.integration.py"))["Acp"]
question = {"id": "format", "question": "Which output format?", "options": [
    {"id": "markdown", "title": "Markdown", "description": "Readable text", "recommended": True},
    {"id": "json", "title": "JSON", "description": "Structured text"},
]}


class Gateway(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        messages = body["messages"]
        index = max(i for i, msg in enumerate(messages) if msg["role"] == "user")
        prompt = messages[index]["content"]
        if isinstance(prompt, list):
            prompt = "\n".join(block["text"] for block in prompt if block["type"] == "text")
        results = [json.loads(msg["content"]) for msg in messages[index:] if msg["role"] == "tool"]
        assert "ask_user" in [tool["function"]["name"] for tool in body["tools"]]
        finish, delta = "stop", {"content": "BARE_INPUT_AS_MESSAGE"}
        if results:
            assert len(results) == 1 and results[0]["status"] == "answered", results
            content = results[0]["answer"]
            assert content == ({"kind": "custom", "text": "CSV please"} if "custom" in prompt else
                               {"kind": "option", "optionId": "markdown"}), results
            delta = {"content": "CONFIRMED_ANSWER"}
        elif prompt != "1":
            calls = [("ask_user", question)]
            if "mixed" in prompt:
                calls.insert(0, ("write", {"path": "unexpected.txt", "content": "never written"}))
            if "parallel" in prompt:
                calls.append(("ask_user", question))
            delta = {"tool_calls": [
                {"index": i, "id": f"call_{len(self.requests)}_{i}", "type": "function",
                 "function": {"name": name, "arguments": json.dumps(args)}}
                for i, (name, args) in enumerate(calls)
            ]}
            finish = "tool_calls"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for part, reason in (({"role": "assistant", **delta}, None), ({}, finish)):
            stream = {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                      "model": "fixture-think", "choices": [{"index": 0, "delta": part, "finish_reason": reason}]}
            self.wfile.write(f"data: {json.dumps(stream)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


def terminal(binary, project, env):
    with pexpect.spawn(binary, ["--sandbox=workspace-write"], cwd=str(project), env=env,
                       encoding="utf-8", timeout=30) as tty:
        tty.expect_exact("codey-sandbox> ")
        tty.sendline("option A")
        tty.expect_exact("Markdown [Recommended] — Readable text")
        tty.expect_exact("Choose a number")
        tty.sendline("1")
        tty.expect(r"Type (send [0-9a-f]{8})")
        stale = tty.match.group(1)
        tty.send("\x03")
        tty.expect_exact("Question canceled.")
        tty.expect_exact("codey-sandbox> ")
        tty.sendline("option B")
        tty.expect_exact("Choose a number")
        tty.sendline("1")
        tty.expect(r"Type (send [0-9a-f]{8})")
        assert stale != tty.match.group(1)
        tty.sendline(stale)
        tty.expect_exact("Question canceled.")
        tty.expect_exact("codey-sandbox> ")
        tty.sendline("custom fixture")
        tty.expect_exact("Choose a number")
        tty.sendline("3")
        tty.expect_exact("Your answer:")
        tty.sendline("CSV please")
        tty.expect(r"Type (send [0-9a-f]{8})")
        assert len(Gateway.requests) == 3
        tty.sendline(tty.match.group(1))
        tty.expect_exact("CONFIRMED_ANSWER")
        tty.expect_exact("codey-sandbox> ")
        tty.sendline("mixed fixture")
        tty.expect_exact("No action was taken.")
        tty.expect_exact("codey-sandbox> ")
        assert len(Gateway.requests) == 5
        tty.sendline("/quit")
        tty.expect(pexpect.EOF)


def pi_rpc(binary, project, env):
    with Rpc(binary, ["--sandbox=workspace-write", "--mode", "rpc", "--no-session"], project, env) as client:
        for prompt, expected in [("question", "Reply with a choice"), ("1", "BARE_INPUT_AS_MESSAGE"),
                                 ("mixed fixture", "No action was taken."), ("parallel", "No action was taken.")]:
            before = len(Gateway.requests)
            start = len(client.seen)
            client.request("prompt", message=prompt)
            client.until(lambda frame: frame.get("type") == "agent_end")
            seen = client.seen[start:]
            assert expected in "".join(frame.get("assistantMessageEvent", {}).get("delta", "") for frame in seen)
            assert len(Gateway.requests) == before + 1
            assert not any(frame.get("type") in ("extension_ui_request", "tool_execution_start") for frame in seen)


def acp(binary, project, env):
    args = ["acp", "--sandbox=workspace-write"]
    with Acp(binary, args, project, env) as client:
        client.initialize()
        session = client.request("session/new", cwd=str(project), mcpServers=[])["sessionId"]
        for prompt, expected in [("question", "Reply with a choice"), ("1", "BARE_INPUT_AS_MESSAGE"),
                                 ("mixed fixture", "No action was taken.")]:
            before = len(Gateway.requests)
            start = len(client.seen)
            result = client.request("session/prompt", sessionId=session, prompt=[{"type": "text", "text": prompt}])
            assert result == {"stopReason": "end_turn"}
            events = client.seen[start:]
            assert expected in "".join(event.get("params", {}).get("update", {}).get("content", {}).get("text", "") for event in events)
            assert len(Gateway.requests) == before + 1
            assert all(event.get("method") in (None, "session/update") for event in events)
            assert not any(event.get("params", {}).get("update", {}).get("sessionUpdate") == "tool_call" for event in events)

    with Acp(binary, args, project, env) as client:
        client.request("initialize", protocolVersion=1, clientCapabilities={"elicitation": {"form": {}}})
        session = client.request("session/new", cwd=str(project), mcpServers=[])["sessionId"]

        def start(prompt, turn):
            client.send({"jsonrpc": "2.0", "id": turn, "method": "session/prompt",
                         "params": {"sessionId": session, "prompt": [{"type": "text", "text": prompt}]}})
            request = client.until(lambda frame: frame.get("method") == "elicitation/create")
            assert request["params"]["sessionId"] == session and request["params"]["mode"] == "form"
            fields = request["params"]["requestedSchema"]["properties"]
            assert all("default" not in value for value in fields.values())
            return request["id"], next(key for key in fields if "oneOf" in fields[key])

        def answer(form, content):
            client.send({"jsonrpc": "2.0", "id": form, "result": {"action": "accept", "content": content}})

        def finish(turn, reason):
            frame = client.until(lambda reply: reply.get("id") == turn)
            assert frame["result"] == {"stopReason": reason}, frame

        before = len(Gateway.requests)
        stale, old_field = start("option A", 101)
        client.send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}})
        finish(101, "cancelled")
        fresh, new_field = start("option B", 102)
        assert stale != fresh and old_field != new_field
        answer(stale, {old_field: "markdown"})
        # A new reply with the wrong form's field must also be rejected.
        answer(fresh, {old_field: "markdown"})
        finish(102, "end_turn")
        assert len(Gateway.requests) == before + 2
        fresh, new_field = start("custom fixture", 103)
        answer(stale, {old_field: "markdown"})
        answer(fresh, {new_field + "__other": "CSV please"})
        finish(103, "end_turn")
        assert len(Gateway.requests) == before + 4
        assert any("CONFIRMED_ANSWER" in str(frame) for frame in client.seen)
        session = client.request("session/new", cwd=str(project), mcpServers=[])["sessionId"]
        current, field = start("option fresh session", 104)
        answer(fresh, {new_field + "__other": "CSV please"})
        answer(current, {field: "markdown"})
        finish(104, "end_turn")
        assert len(Gateway.requests) == before + 6
        assert not any(frame.get("method") == "session/request_permission" for frame in client.seen)


def run(binary, adapter):
    with tempfile.TemporaryDirectory(prefix="codey-sandbox-questions-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Gateway) as server:
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        project.mkdir()
        agent = home / ".codey/agent"
        agent.mkdir(parents=True)
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "api": "openai-completions", "apiKey": "synthetic", "models": [{"id": "fixture-think", "reasoning": True}],
            "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
        }}}))
        Thread(target=server.serve_forever, daemon=True).start()
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm", "NO_COLOR": "1", "PI_SKIP_VERSION_CHECK": "1"}
        terminal(binary, project, env)
        pi_rpc(binary, project, env)
        acp(binary, project, env)
        if adapter:
            subprocess.run(["node", adapter, binary, str(project), "question"], env=env, check=True, timeout=75)
        assert not list(project.iterdir())
    print("PASS: installed Seatbelt terminal, sandbox Pi RPC and ACP clarification, stale replies and blocked batches.")


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()), sys.argv[2] if len(sys.argv) > 2 else None)
