"""Exercise the actual /provider menus and inspect synthetic outbound requests."""

import json
import os
import re
import runpy
import sys
import tempfile
import time
from http.server import ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from threading import Thread

import pexpect


ROOT = Path(__file__).resolve().parents[1]
Rpc = runpy.run_path(str(ROOT / "sandbox/macos/rpc.integration.py"))["Rpc"]
ResponsesGateway = runpy.run_path(str(Path(__file__).with_name("provider-reasoning.integration.py")))["Gateway"]
ROUTE = "openai/gpt-6.2-sol"
ASTRA = "openai/gpt-6.2-astra"


class Terminal(pexpect.spawn):
    def __enter__(self):
        self.logfile_read = StringIO()
        return super().__enter__()

    def __exit__(self, error, *args):
        if error:
            trace = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", self.logfile_read.getvalue())
            print("\n".join(line.rstrip() for line in trace.splitlines() if line.strip())[-4000:], file=sys.stderr)
        return super().__exit__(error, *args)


class Gateway(ResponsesGateway):
    output = 128000
    catalogs = []

    def do_GET(self):
        self.catalogs.append((self.path, self.headers.get("Authorization")))
        if self.path == "/v1/models":
            data = [{"id": ROUTE}, {"id": ASTRA}]
        elif self.path == "/v1/model/info":
            data = [{"model_name": ROUTE, "model_info": {"max_input_tokens": 922000, "max_output_tokens": self.output}}]
        elif self.path == "/new/v1/models":
            data = [{"id": "new-route", "context_window": 64000, "max_output_tokens": 6000}]
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"data": data}).encode())


def run(binary, include_sandbox=False):
    with tempfile.TemporaryDirectory(prefix="codey-provider-limits-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Gateway) as server:
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        folder = home / ".codey/agent/custom-providers"
        folder.mkdir(parents=True)
        project.mkdir()
        origin = f"http://127.0.0.1:{server.server_port}"
        original = {"id": "relay", "displayName": "Relay", "api": "openai-responses", "baseUrl": origin + "/v1",
                    "auth": "key", "key": "fixture-limit-key", "models": [ROUTE, ASTRA, "unlisted"],
                    "reasoningLevels": {ROUTE: ["low", "high"]}}
        file = folder / "relay.json"
        file.write_text(json.dumps(original))
        file.chmod(0o600)
        Thread(target=server.serve_forever, daemon=True).start()
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color",
               "NO_COLOR": "1", "PI_SKIP_VERSION_CHECK": "1"}

        with Terminal(binary, ["--no-session", "--offline", "--provider", "relay", "--model", ROUTE],
                           cwd=project, env=env, encoding="utf-8", timeout=30, dimensions=(55, 200)) as tty:
            def enter(text="", down=0):
                if text:
                    tty.send(text)
                    time.sleep(.17)
                for _ in range(down):
                    tty.send("\x1b[B")
                    time.sleep(.075)
                tty.send("\r")

            def configure():
                enter("/provider")
                tty.expect_exact("Configure model limits")
                enter(down=6)
                tty.expect_exact("Choose saved provider")
                enter()
                tty.expect_exact("Choose a model for token limits")
                enter()
                tty.expect_exact("Token limits for")

            def refresh():
                enter()
                tty.expect_exact("Read limits from the configured gateway?")
                enter()

            def save(confirm=True):
                original_bytes = file.read_bytes()
                tty.expect_exact("Keep model limits")
                enter(down=4)
                tty.expect_exact("Save token limits for")
                tty.expect_exact("Save model limits")
                tty.expect_exact("\x1b[?2026l")
                if confirm:
                    tty.send("\x1b[B")
                    tty.expect(r"→ (?:\x1b\[[0-9;]+m)*Save model limits")
                enter()
                if confirm:
                    deadline = time.monotonic() + 10
                    while file.read_bytes() == original_bytes and time.monotonic() < deadline:
                        # A macOS PTY can block rendering until output is consumed.
                        try:
                            tty.read_nonblocking(size=4096, timeout=.15)
                        except pexpect.TIMEOUT:
                            pass
                    assert file.read_bytes() != original_bytes, "The confirmed changes were not saved."
                time.sleep(.25)

            tty.expect_exact("\x1b[?2026l")
            time.sleep(.75)
            configure()
            tty.expect_exact("Context window: 1050000 tokens (Models.dev)")
            tty.expect_exact("Output limit: 128000 tokens (Models.dev)")
            tty.expect_exact("Input limit: 922000 tokens (Models.dev)")
            assert not Gateway.catalogs
            refresh()
            tty.expect_exact("Output limit: 128000 tokens (Gateway model info)")
            tty.expect_exact("Input limit: 922000 tokens (Gateway model info)")
            save(False)
            assert json.loads(file.read_text()) == original

            configure()
            refresh()
            tty.expect_exact("Output limit: 128000 tokens (Gateway model info)")
            enter(down=2)
            tty.expect_exact("Output limit in tokens")
            enter("10000")
            tty.expect_exact("Output limit: 10000 tokens (Manual)")
            enter(down=1)
            tty.expect_exact("Context window in tokens")
            enter("144000")
            tty.expect_exact("Context window: 144000 tokens (Manual)")
            save()
            enter("wire from the active terminal model")
            tty.expect_exact("WIRE_OK")
            assert Gateway.requests[-1][1]["max_output_tokens"] == 10000

            Gateway.output = 6000
            configure()
            refresh()
            tty.expect_exact("Output limit: 10000 tokens (Manual)")
            save()
            stored = json.loads(file.read_text())
            saved_limits = stored["modelLimits"][ROUTE]
            snapshot = json.loads((ROOT / "catalog/model-limits.json").read_text())
            assert saved_limits == {
                "modelsDevRevision": snapshot["revision"],
                "detected": {"maxInputTokens": {"value": 922000, "source": "Gateway model info"},
                             "maxTokens": {"value": 6000, "source": "Gateway model info"}},
                "manual": {"contextWindow": 144000, "maxTokens": 10000},
            }
            configure()
            enter(down=2)
            tty.expect_exact("Output limit in tokens")
            tty.send("\x05\x15")
            enter()
            tty.expect_exact("Output limit: 6000 tokens (Gateway model info)")
            save()

            enter("/provider")
            tty.expect_exact("Add provider")
            enter()
            tty.expect_exact("New provider name")
            enter("Other")
            tty.expect_exact("Provider protocol")
            enter(down=1)
            tty.expect_exact("API Base URL")
            enter(origin + "/new/v1")
            tty.expect_exact("Provider authentication")
            enter(down=1)
            tty.expect_exact("Discover via the model catalog")
            enter()
            tty.expect_exact("Request the model catalog?")
            enter()
            tty.expect_exact("Select catalog models")
            enter()
            tty.send("\x13")
            tty.expect_exact("1 selected")
            enter(down=3)
            tty.expect_exact("Save provider")
            enter(down=1)
            tty.expect_exact("Custom provider saved")
            enter("/quit")
            tty.expect(pexpect.EOF)

        current = json.loads(file.read_text())
        assert current["modelLimits"][ROUTE]["manual"] == {"contextWindow": 144000}
        assert {key: value for key, value in current.items() if key != "modelLimits"} == original
        added = json.loads((folder / "other.json").read_text())
        assert added["modelLimits"]["new-route"]["detected"]["contextWindow"]["value"] == 64000
        assert all(auth == "Bearer fixture-limit-key" for path, auth in Gateway.catalogs if not path.startswith("/new"))

        modes = [["--mode", "rpc", "--no-session", "--offline"]]
        if include_sandbox:
            modes.append(["--mode", "rpc", "--sandbox", "workspace-write", "--no-session"])
        for mode in modes:
            with Rpc(binary, mode, project, env) as rpc:
                models = rpc.request("get_available_models")["models"]
                actual = next(item for item in models if item["provider"] == "relay" and item["id"] == ROUTE)
                assert (actual["contextWindow"], actual["maxTokens"]) == (144000, 6000), actual
                astra = next(item for item in models if item["provider"] == "relay" and item["id"] == ASTRA)
                assert (astra["contextWindow"], astra["maxTokens"]) == (1050000, 128000), astra
                unknown = next(item for item in models if item["provider"] == "relay" and item["id"] == "unlisted")
                assert (unknown["contextWindow"], unknown["maxTokens"]) == (32000, 4096), unknown
                assert not actual.get("baseUrl") and "fixture-limit-key" not in json.dumps(actual)
                assert actual["thinkingLevelMap"]["high"] == "high"
                rpc.request("set_model", provider="relay", modelId=ROUTE)
                rpc.request("prompt", message="wire after restart")
                rpc.until(lambda frame: frame.get("type") == "agent_settled")
                assert Gateway.requests[-1][1]["max_output_tokens"] == 6000
        print("PASS: actual /provider discovery, active model, manual edits, gateway refresh, reset, new provider, and reopened RPC wire.", flush=True)


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()), "--sandbox" in sys.argv[2:])
