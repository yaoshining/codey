"""Run Codey ACP over stdio and exercise the installed entry on real Apple Seatbelt."""
import json
import os
from pathlib import Path
import runpy
import shlex
import subprocess
import sys
import tempfile
from http.server import ThreadingHTTPServer
from threading import Thread


fixtures = runpy.run_path(str(Path(__file__).with_name("rpc.integration.py")))
Model, Rpc = fixtures["Model"], fixtures["Rpc"]
args = ["acp", "--sandbox=workspace-write"]
alias = "litellm/openai/fixture-one"
alias_levels = ["off", "low", "medium", "high", "xhigh", "max"]


class Gateway(Model):
    responses = []

    def do_POST(self):
        if self.path != "/v1/responses":
            return super().do_POST()
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.responses.append((body, self.headers.get("Authorization")))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        item = {"type": "message", "id": "fixture", "role": "assistant", "status": "in_progress", "content": []}
        text = {"type": "output_text", "text": "ALIAS_OK"}
        for event in [
            {"type": "response.output_item.added", "item": item},
            {"type": "response.content_part.added", "part": {**text, "text": ""}},
            {"type": "response.output_text.delta", "delta": text["text"]},
            {"type": "response.output_item.done", "item": {**item, "status": "completed", "content": [text]}},
            {"type": "response.completed", "response": {"status": "completed",
             "usage": {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}}},
        ]:
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())


class Acp(Rpc):
    def request(self, method, *, succeeds=True, **params):
        self.next_id += 1
        request_id = self.next_id
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        if method == "session/prompt" and params.get("prompt") == [{"type": "text", "text": "slow fixture"}]:
            self.until(lambda frame: frame.get("params", {}).get("update", {}).get("content", {}).get("text") == "SLOW_STARTED")
            self.send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": params["sessionId"]}})
        response = self.until(lambda frame: frame.get("id") == request_id)
        assert response["jsonrpc"] == "2.0" and ("result" in response) == succeeds, response
        return response.get("result") if succeeds else response["error"]

    def initialize(self):
        result = self.request("initialize", protocolVersion=2,
                              clientCapabilities={"fs": {"readTextFile": True}, "terminal": True})
        assert result["protocolVersion"] == 1 and result["agentCapabilities"]["loadSession"]
        assert result["agentInfo"]["name"] == "codey" and not result["agentCapabilities"].get("mcpCapabilities")


def run(binary, t3_fixture=None):
    with tempfile.TemporaryDirectory(prefix="codey-acp-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Gateway) as server:
        root = Path(temp).resolve()
        home, workspace, other = [root / name for name in ("home", "workspace", "other")]
        for folder in (home, workspace, other):
            folder.mkdir()
        agent = home / ".codey/agent"
        agent.mkdir(parents=True)
        endpoint = f"http://127.0.0.1:{server.server_port}"
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "api": "openai-completions", "apiKey": "acp-fixture-key", "baseUrl": endpoint + "/v1",
            "models": [{"id": "fixture-one"}, {"id": "fixture-think", "reasoning": True,
                          "compat": {"supportsReasoningEffort": True}}],
        }}}))
        (agent / "settings.json").write_text(json.dumps({"defaultProvider": "fixture", "defaultModel": "fixture-one"}))
        profiles = agent / "custom-providers"
        profiles.mkdir(mode=0o700)
        profile = profiles / "litellm.json"
        profile.write_text(json.dumps({"displayName": "LiteLLM", "api": "openai-responses",
                                      "auth": "key", "key": "fake-litellm-key", "baseUrl": endpoint + "/v1",
                                      "models": ["openai/fixture-one"],
                                      "reasoningLevels": {"openai/fixture-one": alias_levels[1:]}}))
        profile.chmod(0o600)
        (workspace / ".env").write_text("protected")
        marker = other / "fixture"
        marker.write_text("outside")
        injected = other / "injected"
        command = f"/bin/echo unsafe > {shlex.quote(str(injected))}"
        Model.shell = (f"if /bin/cat {shlex.quote(str(marker))}; then exit 5; fi; "
                       f"if /bin/echo bad >> {shlex.quote(str(marker))}; then exit 5; fi; "
                       "if /bin/cat .env; then exit 5; fi; "
                       'test -z "$T3_ACP_MCP_AUTHORIZATION" || exit 5; '
                       f"if /usr/bin/curl --silent --noproxy '*' --max-time 2 {endpoint}/probe; then exit 5; fi; "
                       "/bin/echo allowed > acp-output; /bin/echo BOUNDARY_OK")
        Thread(target=server.serve_forever, daemon=True).start()
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "PI_SKIP_VERSION_CHECK": "1",
               "T3_ACP_MCP_AUTHORIZATION": "synthetic-ignored-token"}
        subprocess.run(["/usr/bin/curl", "--silent", "--noproxy", "*", endpoint + "/probe"], check=True, env=env)
        for directory in ("/", str(home), str(workspace)):
            with Acp(binary, args, directory, env) as probe:
                caps = probe.request("initialize", protocolVersion=2,
                                     clientInfo={"name": "t3-code-provider-test", "version": "0.0.0"},
                                     clientCapabilities={"fs": {"readTextFile": True}, "terminal": True})["agentCapabilities"]
                assert not caps.get("loadSession") and caps["sessionCapabilities"]["delete"] == {}
                setup = {"cwd": directory, "mcpServers": []}
                result = probe.request("session/new", **setup)
                sid = result["sessionId"]
                assert {option["value"] for option in result["configOptions"][0]["options"]} == {
                    "fixture/fixture-one", "fixture/fixture-think", alias
                }
                assert result["models"]["currentModelId"] == "fixture/fixture-one"
                catalog = {entry["modelId"]: entry for entry in result["models"]["availableModels"]}
                assert catalog[alias]["name"] == "openai/fixture-one"
                assert [item["value"] for item in catalog[alias]["_meta"]["reasoningEfforts"]] == alias_levels
                assert catalog["fixture/fixture-one"]["_meta"]["reasoningEfforts"] == [{"value": "off", "label": "off"}]
                probe.request("session/set_config_option", sessionId=sid, configId="model", value="fixture/fixture-think")
                probe.request("session/set_config_option", sessionId=sid, configId="thinking", value="low")
                probe.request("session/prompt", sessionId=sid, prompt=[{"type": "text", "text": "boundary fixture"}], succeeds=False)
                probe.request("session/load", sessionId=sid, **setup, succeeds=False)
                probe.request("terminal/create", command="/bin/sh", succeeds=False)
                probe.request("session/new", **{**setup, "mcpServers": [{"command": "/bin/sh", "args": ["-c", command]}]}, succeeds=False)
                probe.request("session/new", **setup, additionalDirectories=[str(workspace)], succeeds=False)
                probe.request("initialize", protocolVersion=1, clientInfo={"name": "standard"}, succeeds=False)
                probe.request("session/delete", sessionId=sid)
                probe.request("session/set_config_option", sessionId=sid, configId="thinking", value="low", succeeds=False)
                assert not any("method" in frame for frame in probe.seen), probe.seen
            if directory != str(workspace):
                with Acp(binary, args, directory, env) as standard:
                    standard.request("initialize", protocolVersion=1, clientInfo={"name": "ordinary-t3-chat"}, succeeds=False)
                    standard.request("session/new", cwd=directory, mcpServers=[], succeeds=False)
        if t3_fixture:
            version = subprocess.check_output([binary, "--version"], text=True, cwd=workspace, env=env).strip()
            subprocess.run(["node", t3_fixture, binary, str(workspace), "probe", version], check=True, env=env, timeout=140)
        assert not Model.requests and not Gateway.responses and Model.probes == 1 and not injected.exists()
        assert not (agent / "sandbox-acp").exists() and not (agent / "auth.json").exists()
        print("PASS: discovery only, with invalid workspace roots, no persistence, network or tools.", flush=True)
        setup = {"cwd": str(workspace), "mcpServers": []}
        with Acp(binary, args, workspace, env) as acp:
            assert not acp.request("session/new", succeeds=False, **setup).get("data")
            acp.initialize()
            acp.send(b"{bad json\n" + b"x" * (257 * 1024) + b"\n")
            assert acp.until(lambda frame: frame.get("error", {}).get("code") == -32700)["id"] is None
            assert acp.until(lambda frame: "exceeded" in frame.get("error", {}).get("message", ""))["id"] is None
            assert acp.request("session/new", succeeds=False, **{**setup, "cwd": str(other)})["code"] == -32602
            assert acp.request("session/new", succeeds=False, **setup, additionalDirectories=[str(other)])["code"] == -32602
            result = acp.request("session/new", **{**setup, "mcpServers": [
                {"name": "ignored", "command": "/bin/sh", "args": ["-c", command], "env": []},
                {"type": "http", "name": "ignored-http", "url": endpoint + "/probe", "headers": []},
            ]})
            session_id = result["sessionId"]
            assert "/" not in session_id
            files = list((agent / "sandbox-acp").glob("*/*.jsonl"))
            assert len(files) == 1 and files[0].name == session_id and files[0].stat().st_mode & 0o777 == 0o600
            assert len(result["configOptions"][0]["options"]) == 3
            model = acp.request("session/set_config_option", sessionId=session_id, configId="model", value="fixture/fixture-think")
            thinking = model["configOptions"][1]["options"]
            selected = next(option["value"] for option in thinking if option["value"] == "low")
            acp.request("session/set_config_option", sessionId=session_id, configId="thinking", value=selected)
            acp.request("session/set_config_option", sessionId=session_id, configId="thinking", value="unavailable", succeeds=False)
            assert acp.request("terminal/create", command="/bin/echo", succeeds=False)["code"] == -32601
            acp.request("session/prompt", sessionId=session_id, prompt=[{"type": "image", "data": "ignored"}], succeeds=False)
            result = acp.request("session/prompt", sessionId=session_id, prompt=[
                {"type": "text", "text": "boundary fixture"},
                {"type": "resource_link", "name": "Fixture", "uri": endpoint + "/probe"},
            ])
            assert result["stopReason"] == "end_turn"
            assert (workspace / "acp-output").read_text() == "allowed\n"
            assert (workspace / ".env").read_text() == "protected" and marker.read_text() == "outside"
            assert not injected.exists() and Model.probes == 1
            assert any(frame.get("params", {}).get("update", {}).get("sessionUpdate") == "tool_call_update" for frame in acp.seen)
            assert any(frame.get("params", {}).get("update", {}).get("content", {}).get("text") == "STREAM_OK" for frame in acp.seen)
            assert not any("id" in frame and "method" in frame for frame in acp.seen)
            assert Model.requests[0]["model"] == "fixture-think" and Model.requests[0]["reasoning_effort"] == "low"
            assert "contents not loaded" in str(Model.requests[0]["messages"])
            assert acp.request("session/prompt", sessionId=session_id, prompt=[{"type": "text", "text": "slow fixture"}])["stopReason"] == "cancelled"
            Model.release.set()
            changed = acp.request("session/set_config_option", sessionId=session_id, configId="model", value=alias)
            assert [option["value"] for option in changed["configOptions"][1]["options"]] == alias_levels
            acp.request("session/set_config_option", sessionId=session_id, configId="thinking", value="high")
            assert acp.request("session/prompt", sessionId=session_id,
                               prompt=[{"type": "text", "text": "alias wire fixture"}])["stopReason"] == "end_turn"
            body, auth = Gateway.responses[-1]
            assert body["model"] == "openai/fixture-one" and body["reasoning"]["effort"] == "high"
            assert auth == "Bearer fake-litellm-key"
            acp.request("session/set_config_option", sessionId=session_id, configId="model", value="fixture/fixture-think")
            with Acp(binary, args, workspace, env) as competing:
                competing.initialize()
                assert "in use" in competing.request("session/load", sessionId=session_id, **setup, succeeds=False)["message"]
        with Acp(binary, args, workspace, env) as resumed:
            resumed.initialize()
            assert resumed.request("session/load", sessionId=str(files[0]), **setup, succeeds=False)["code"] == -32602
            state = resumed.request("session/load", sessionId=session_id, **setup)
            assert state["configOptions"][0]["currentValue"] == "fixture/fixture-think"
            assert any("boundary fixture" in str(frame.get("params", {})) for frame in resumed.seen)
            assert resumed.request("session/prompt", sessionId=session_id,
                                   prompt=[{"type": "text", "text": "continue fixture"}])["stopReason"] == "end_turn"
        with Acp(binary, args, other, env) as foreign:
            foreign.initialize()
            foreign.request("session/load", sessionId=session_id, cwd=str(other), mcpServers=[], succeeds=False)
        assert len(list((agent / "sandbox-acp").glob("*/*.jsonl"))) == 1
        for flags in (["acp"], [*args, "--no-tools"], [*args, "--mode", "rpc"]):
            output = subprocess.run([binary, *flags], input="", text=True, capture_output=True, env=env, cwd=workspace, timeout=15)
            assert output.returncode != 0 and not output.stdout, output
        print("PASS: installed ACP preserved the alias route and authorization, sent high effort, and passed sandbox, stream, cancel and cold resume checks.", flush=True)
        if t3_fixture:
            started = len(Model.requests)
            Model.release.clear()
            subprocess.run(["node", t3_fixture, binary, str(workspace)], check=True, env=env, timeout=140)
            Model.release.set()
            requests = Model.requests[started:]
            assert any(item.get("reasoning_effort") == "low" and "t3-acp-first" in str(item["messages"])
                       and "t3-acp-second" in str(item["messages"]) for item in requests)
            assert not injected.exists() and Model.probes == 1
        server.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()), *sys.argv[2:])
