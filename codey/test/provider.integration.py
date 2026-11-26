"""Drive /provider with a loopback fixture for all three protocol adapters."""

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlsplit

import pexpect


class Gateway(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.seen.append((self.path, self.headers.get("Authorization"), self.headers.get("x-api-key")))
        if not self.path.startswith("/chat/v1/models"):
            self.send_error(404)
            return
        data = ({"data": [{"id": "first"}], "has_more": True, "last_id": "first"}
                if "?" not in self.path else {"data": [{"id": "first"}, {"id": "second"}]})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        path = urlsplit(self.path).path
        self.seen.append((path, self.headers.get("Authorization"), self.headers.get("x-api-key"), body["model"]))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def emit(data, named=False):
            if named:
                self.wfile.write(f"event: {data['type']}\n".encode())
            self.wfile.write(f"data: {json.dumps(data)}\n\n".encode())

        if path.endswith("/chat/completions"):
            text = "CHAT_OK echoed " + self.headers["Authorization"].split()[1]
            for delta, finish in [({"role": "assistant", "content": text}, None), ({}, "stop")]:
                emit({"id": "one", "object": "chat.completion.chunk", "created": 1, "model": body["model"],
                      "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
            self.wfile.write(b"data: [DONE]\n\n")
        elif path.endswith("/responses"):
            item = {"type": "message", "id": "msg_1", "role": "assistant", "status": "in_progress", "content": []}
            text = "RESPONSES_OK"
            for event in [
                {"type": "response.output_item.added", "item": item},
                {"type": "response.content_part.added", "part": {"type": "output_text", "text": ""}},
                {"type": "response.output_text.delta", "delta": text},
                {"type": "response.output_item.done", "item": {**item, "status": "completed", "content": [{"type": "output_text", "text": text}]}},
                {"type": "response.completed", "response": {"status": "completed", "usage": {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}}},
            ]:
                emit(event)
        elif path.endswith("/messages"):
            for kind, values in [
                ("message_start", {"message": {"id": "one", "type": "message", "role": "assistant", "model": body["model"], "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 3, "output_tokens": 0}}}),
                ("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": "MESSAGES_OK"}}),
                ("content_block_stop", {"index": 0}),
                ("message_delta", {"delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
                ("message_stop", {}),
            ]:
                emit({"type": kind, **values}, True)


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-providers-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Gateway) as server:
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        agent = home / ".codey/agent"
        agent.mkdir(parents=True)
        project.mkdir()
        profiles = agent / "custom-providers"
        original = '{ "providers": { "ConfiguredViaModels": { "apiKey": "fixture-config-key" } } }\n'
        original_auth = '{"SavedViaLogin":{"type":"api_key","key":"fixture-login-key"}}\n'
        (agent / "models.json").write_text(original)
        (agent / "auth.json").write_text(original_auth)
        (agent / "auth.json").chmod(0o600)
        Thread(target=server.serve_forever, daemon=True).start()
        endpoint = f"http://127.0.0.1:{server.server_port}"
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color", "NO_COLOR": "1", "PI_SKIP_VERSION_CHECK": "1"}
        log = io.StringIO()
        with pexpect.spawn(binary, ["--no-session", "--offline"], cwd=project, env=env,
                           encoding="utf-8", timeout=20, dimensions=(45, 160)) as tty:
            tty.logfile_read = log

            def enter(text="", down=0):
                if text:
                    tty.send(text)
                    time.sleep(.18)
                for _ in range(down):
                    tty.send("\x1b[B")
                    time.sleep(.08)
                tty.send("\r")

            def escape():
                tty.send("\x03")
                time.sleep(.25)

            def start(name):
                enter("/provider")
                tty.expect_exact("Add provider")
                enter()
                tty.expect_exact("New provider name")
                enter(name)

            def setup(name, protocol, path, key):
                start(name)
                tty.expect_exact("Anthropic Messages")
                enter(down=protocol)
                tty.expect_exact("API Base URL")
                enter(endpoint + path)
                tty.expect_exact("No authentication")
                enter(down=1 if key is None else 0)
                if key is not None:
                    tty.expect_exact("API key (masked)")
                    tty.send(key)
                    tty.expect_exact("*" * len(key))
                    enter()
                tty.expect_exact("Keep selections and continue")

            def manual(id):
                enter(down=1)
                tty.expect_exact("Model IDs (one ID or a JSON array)")
                enter(id)
                tty.expect_exact("Keep selections and continue")

            def save(name, steps):
                enter(down=steps)
                tty.expect_exact("Save provider")
                assert not (profiles / f"{name}.json").exists()
                enter(down=1)
                tty.expect_exact(f"Custom provider saved: {name}.")

            tty.expect_exact("\x1b[?2026l")
            time.sleep(.9)
            enter("/login")
            tty.expect_exact("Sign in with an account")
            tty.expect_exact("Sign in with an API key")
            escape()
            for conflict in ("OpenAI", "configuredviamodels", "SAVEDViaLogin"):
                start(conflict)
                tty.expect_exact("A provider or stored login already uses this ID.")
            assert not profiles.exists()
            start("cancelled")
            tty.expect_exact("Provider protocol")
            escape()
            assert not profiles.exists()
            setup("fixture-chat", 0, "/chat/v1", "fixture-key-original")
            enter()
            tty.expect_exact("Request the model catalog?")
            enter()
            tty.expect_exact("Select catalog models")
            tty.expect_exact("second")
            enter()
            tty.send("second")
            time.sleep(.2)
            enter()
            tty.send("\x13")
            tty.expect_exact("2 selected")
            save("fixture-chat", 3)
            setup("fixture-responses", 1, "/responses/v1", None)
            enter()
            tty.expect_exact("Request the model catalog?")
            enter()
            tty.expect_exact("does not expose this model catalog")
            tty.expect_exact("Keep selections and continue")
            manual("handwritten-response")
            save("fixture-responses", 2)
            setup("fixture-messages", 2, "/anthropic", "fixture-anthropic-key")
            manual("handwritten-message")
            save("fixture-messages", 2)

            enter("/provider")
            tty.expect_exact("Replace API key")
            enter(down=2)
            tty.expect_exact("Choose saved provider")
            enter()
            tty.expect_exact("API key (masked)")
            enter("fixture-key-rotated")
            tty.expect_exact("This replaces the saved authentication")
            enter(down=1)
            tty.expect_exact("API key replaced for fixture-chat.")
            enter("/provider")
            tty.expect_exact("Edit provider or models")
            enter(down=1)
            tty.expect_exact("Choose saved provider")
            enter()
            tty.expect_exact("Provider protocol")
            enter()
            tty.expect_exact("API Base URL")
            tty.expect_exact(endpoint[1:] + "/chat/v1")
            enter()
            tty.expect_exact("Provider authentication")
            enter()
            tty.expect_exact("Keep selections and continue")
            enter(down=1)
            tty.expect_exact('"first","second"]')
            tty.send("\x05\x15")
            time.sleep(.2)
            enter('["first", "second", "manual alias"]')
            tty.expect_exact("Keep selections and continue")
            enter(down=2)
            tty.expect_exact("Save provider")
            enter(down=1)
            tty.expect_exact("Custom provider saved: fixture-chat.")
            enter("/model")
            tty.expect_exact("fixture-responses")
            escape()
            enter("/quit")
            tty.expect(pexpect.EOF)
        for secret in ["fixture-key-original", "fixture-anthropic-key", "fixture-key-rotated"]:
            assert secret not in log.getvalue()
        assert (agent / "models.json").read_text() == original and (agent / "auth.json").read_text() == original_auth
        chat_file = profiles / "fixture-chat.json"
        chat = json.loads(chat_file.read_text())
        assert chat["models"] == ["first", "second", "manual alias"]
        # Simulate an existing pre-display-name profile for the restart below.
        del chat["displayName"]
        chat_file.write_text(json.dumps(chat))
        assert all(path.stat().st_mode & 0o777 == 0o600 for path in profiles.glob("*.json"))
        assert [event[0] for event in Gateway.seen] == ["/chat/v1/models", "/chat/v1/models?after=first", "/responses/v1/models"]
        print("PASS: real /provider TUI, /login, masked keys, cancel/conflict, model discovery with pagination, multi-select, manual fallback, key rotation and /model.", flush=True)

        for model, marker in [("fixture-chat/second", "CHAT_OK"), ("fixture-responses/handwritten-response", "RESPONSES_OK"),
                              ("fixture-messages/handwritten-message", "MESSAGES_OK")]:
            result = subprocess.run([binary, "--model", model, "-p", "fixture prompt"], cwd=project,
                                    env=env, text=True, capture_output=True, timeout=20)
            assert result.returncode == 0 and marker in result.stdout, (model, result.returncode, result.stdout, result.stderr)
            assert "fixture-key-rotated" not in result.stdout + result.stderr
        assert Gateway.seen[-3:] == [
            ("/chat/v1/chat/completions", "Bearer fixture-key-rotated", None, "second"),
            ("/responses/v1/responses", None, None, "handwritten-response"),
            ("/anthropic/v1/messages", None, "fixture-anthropic-key", "handwritten-message"),
        ], Gateway.seen
        transcripts = list((agent / "sessions").rglob("*.jsonl"))
        assert transcripts and all("fixture-key-rotated" not in path.read_text() for path in transcripts)
        print("PASS: all three protocols used the expected path and credential header after restart; no dummy header or key in output or transcripts.", flush=True)
        if sys.platform == "darwin":
            flags = ["--sandbox", "workspace-write", "--provider", "fixture-responses", "--model", "handwritten-response"]
            with pexpect.spawn(binary, flags, cwd=project, env=env, encoding="utf-8", timeout=25) as sandbox:
                sandbox.expect_exact("Model: fixture-responses/handwritten-response")
                sandbox.expect_exact("codey-sandbox> ")
                sandbox.send("local sandbox profile check\r")
                sandbox.expect_exact("RESPONSES_OK")
                sandbox.expect_exact("codey-sandbox> ")
                sandbox.send("/quit\r")
                sandbox.expect(pexpect.EOF)
            assert Gateway.seen[-1] == ("/responses/v1/responses", None, None, "handwritten-response")
            print("PASS: macOS sandbox reused the ordinary Codey profile through its trusted host.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
