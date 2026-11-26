"""Configure existing models in the terminal and capture the two protocol wire formats."""

import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pexpect


Rpc = runpy.run_path(str(Path(__file__).resolve().parents[1] / "sandbox/macos/rpc.integration.py"))["Rpc"]
KEY = "fixture-reasoning-secret"


class Gateway(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append((self.path, body, self.headers.get("Authorization")))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def emit(event):
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())

        if self.path == "/v1/responses":
            item = {"type": "message", "id": "msg_1", "role": "assistant", "status": "in_progress", "content": []}
            for event in [
                {"type": "response.output_item.added", "item": item},
                {"type": "response.content_part.added", "part": {"type": "output_text", "text": ""}},
                {"type": "response.output_text.delta", "delta": "WIRE_OK"},
                {"type": "response.output_item.done", "item": {**item, "status": "completed",
                 "content": [{"type": "output_text", "text": "WIRE_OK"}]}},
                {"type": "response.completed", "response": {"status": "completed",
                 "usage": {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}}},
            ]:
                emit(event)
        else:
            assert self.path == "/v1/chat/completions", self.path
            for delta, finish in [({"role": "assistant", "content": "WIRE_OK"}, None), ({}, "stop")]:
                emit({"id": "one", "object": "chat.completion.chunk", "created": 1, "model": body["model"],
                      "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
            self.wfile.write(b"data: [DONE]\n\n")


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-reasoning-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Gateway) as server:
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        profiles = home / ".codey/agent/custom-providers"
        profiles.mkdir(parents=True)
        project.mkdir()
        base = f"http://localhost:{server.server_port}/v1"
        initial = {}
        for provider, api, url in [("a-responses", "openai-responses", base),
                                    ("b-chat", "openai-completions", base),
                                    ("c-anthropic", "anthropic-messages", base.removesuffix("/v1"))]:
            profile = {"id": provider, "displayName": provider.upper(), "baseUrl": url, "lanHttpApprovedUrl": url,
                       "api": api, "auth": "key", "key": KEY, "models": ["openai/fixture", "unconfigured-model"]}
            path = profiles / f"{provider}.json"
            path.write_text(json.dumps(profile))
            path.chmod(0o600)
            initial[provider] = profile
        Thread(target=server.serve_forever, daemon=True).start()
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color", "NO_COLOR": "1",
               "PI_SKIP_VERSION_CHECK": "1"}

        with pexpect.spawn(binary, ["--no-session", "--offline"], cwd=project, env=env, encoding="utf-8",
                           timeout=25, dimensions=(45, 190)) as tty:
            def enter(text="", down=0):
                if text:
                    tty.send(text)
                    time.sleep(.18)
                for _ in range(down):
                    tty.send("\x1b[B")
                    time.sleep(.08)
                tty.send("\r")

            def open_reasoning(index):
                enter("/provider")
                tty.expect_exact("Configure model reasoning")
                enter(down=5)
                tty.expect_exact("Choose saved provider")
                enter(down=index)

            tty.expect_exact("\x1b[?2026l")
            time.sleep(.8)
            for index, steps in [(0, [1, 2, 2]), (1, [0, 2])]:
                open_reasoning(index)
                tty.expect_exact("Choose an existing model")
                enter()
                tty.expect_exact("Select supported reasoning levels")
                for step in steps:
                    enter(down=step)
                tty.send("\x13")
                tty.expect_exact("Save reasoning levels")
                if index == 0:
                    # Cancel the confirmation once, then repeat the same choices.
                    enter()
                    assert json.loads((profiles / "a-responses.json").read_text()) == initial["a-responses"]
                    open_reasoning(index)
                    tty.expect_exact("Choose an existing model")
                    enter()
                    tty.expect_exact("Select supported reasoning levels")
                    for step in steps:
                        enter(down=step)
                    tty.send("\x13")
                    tty.expect_exact("Save reasoning levels")
                enter(down=1)
                provider = ("a-responses", "b-chat")[index]
                tty.expect_exact(f"Reasoning settings saved for {provider}/openai/fixture.")
            open_reasoning(2)
            tty.expect_exact("Anthropic Messages uses a different reasoning configuration")
            enter("/quit")
            tty.expect(pexpect.EOF)

        assert not Gateway.requests
        selected = {"a-responses": ["low", "high", "max"], "b-chat": ["low", "high"]}
        for provider, old in initial.items():
            profile = json.loads((profiles / f"{provider}.json").read_text())
            new = {"reasoningLevels": {"openai/fixture": selected[provider]}} if provider in selected else {}
            assert profile == {**old, **new}, provider
        print("PASS: real /provider menu updated just the selected models, Cancel preserved the profile, and Anthropic was refused.", flush=True)

        def verify(mode, sandbox):
            with Rpc(binary, mode, project, env) as rpc:
                models = rpc.request("get_available_models")["models"]
                for provider, levels in selected.items():
                    chosen = [model for model in models if model["provider"] == provider]
                    assert len(chosen) == 2
                    assert all(not model.get("baseUrl") and not model.get("headers") for model in chosen)
                    assert KEY not in json.dumps(chosen)
                    by_id = {model["id"]: model for model in chosen}
                    advertised = by_id["openai/fixture"]
                    assert advertised["reasoning"] and all(advertised["thinkingLevelMap"][level] == level for level in levels)
                    assert advertised["thinkingLevelMap"]["medium"] is None
                    assert not by_id["unconfigured-model"]["reasoning"]

                def turn(expected, api, model):
                    start = len(rpc.seen)
                    before = len(Gateway.requests)
                    assert rpc.request("prompt", message="synthetic reasoning test") == {"disposition": "started"}
                    rpc.until(lambda frame: frame.get("type") == "agent_settled")
                    assert any(frame.get("assistantMessageEvent", {}).get("delta") == "WIRE_OK" for frame in rpc.seen[start:])
                    assert len(Gateway.requests) == before + 1
                    path, payload, header = Gateway.requests[-1]
                    assert path == f"/v1/{api}" and payload["model"] == model and header == f"Bearer {KEY}", (path, model)
                    if api == "responses":
                        assert "reasoning_effort" not in payload
                        if expected:
                            assert payload["reasoning"]["effort"] == expected, payload
                        else:
                            assert "reasoning" not in payload, payload
                    else:
                        assert "reasoning" not in payload
                        if expected:
                            assert payload["reasoning_effort"] == expected, payload
                        else:
                            assert "reasoning_effort" not in payload, payload

                for provider, api in [("a-responses", "responses"), ("b-chat", "chat/completions")]:
                    level_options = selected[provider]
                    model = rpc.request("set_model", provider=provider, modelId="openai/fixture")
                    assert model["thinkingLevelMap"]["low"] == "low" and not model.get("baseUrl")
                    assert rpc.request("get_available_thinking_levels")["levels"] == ["off", *level_options]
                    for level in level_options + ["off"]:
                        rpc.request("set_thinking_level", level=level)
                        state = rpc.request("get_state")
                        assert state["thinkingLevel"] == level and not state["model"].get("baseUrl")
                        turn(level if level != "off" else None, api, "openai/fixture")
                    for level in ["medium", "unknown"]:
                        rpc.request("set_thinking_level", level=level, succeeds=not sandbox)
                        # Pi's ordinary RPC clamps invalid input. Sandbox RPC rejects it.
                        effective = rpc.request("get_state")["thinkingLevel"]
                        assert effective in (["off"] if sandbox else ["off", *level_options])
                        turn(effective if effective != "off" else None, api, "openai/fixture")
                    rpc.request("set_model", provider=provider, modelId="unconfigured-model")
                    assert rpc.request("get_available_thinking_levels")["levels"] == ["off"]
                    turn(None, api, "unconfigured-model")
            print(f"PASS: {'Seatbelt' if sandbox else 'ordinary'} RPC preserved levels after restart and sent only supported fields and values on the wire.", flush=True)

        verify(["--mode", "rpc", "--no-session", "--offline", "--no-approve"], False)
        if sys.platform == "darwin":
            verify(["--sandbox", "workspace-write", "--mode", "rpc", "--no-session"], True)
        server.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
