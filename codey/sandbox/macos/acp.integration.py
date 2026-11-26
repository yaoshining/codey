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
    with tempfile.TemporaryDirectory(prefix="codey-acp-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
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
            assert len(result["configOptions"][0]["options"]) == 2
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
        print("PASS: installed Codey ACP v1 negotiation, safe workspace binding, model/effort, streamed tool and text, cancel, replay, locks and cold resume.", flush=True)
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
