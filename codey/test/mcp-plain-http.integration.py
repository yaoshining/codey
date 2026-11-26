"""Exercise the ordinary Codey terminal with synthetic DNS, MCP, and model servers."""

import json
import os
import runpy
import stat
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pexpect


HERE = Path(__file__).resolve().parent
enter = runpy.run_path(str(HERE / "mcp-direct.integration.py"))["enter"]
Proxy = runpy.run_path(str(HERE / "provider-lan.integration.py"))["Proxy"]
TOOL = "mcp__Local__echo_fixture"


class Server(BaseHTTPRequestHandler):
    requests = []
    model_received_tool = False

    def log_message(self, *_args):
        pass

    def reply(self, status, data=None, **headers):
        self.send_response(status)
        if data is not None:
            self.send_header("Content-Type", "application/json")
        for name, value in headers.items():
            self.send_header(name.replace("_", "-"), value)
        self.end_headers()
        if data is not None:
            self.wfile.write(json.dumps(data).encode())

    def record(self, method):
        self.requests.append((self.path, method, self.headers["Host"], [
            self.headers.get(header) for header in ("Authorization", "Proxy-Authorization", "Cookie")
        ]))

    def do_GET(self):
        self.record("GET")
        self.reply(405)

    def do_POST(self):
        message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/v1/chat/completions":
            return self.model(message)
        method = message["method"]
        self.record(method)
        if self.path == "/redirect":
            return self.reply(307, Location=f"http://127.0.0.1:{self.server.server_port}/target")
        if self.path == "/auth":
            return self.reply(401, WWW_Authenticate=(
                f'Bearer resource_metadata="http://127.0.0.1:{self.server.server_port}/metadata"'
            ))
        if "id" not in message:
            return self.reply(202)
        if method == "initialize":
            result = {"protocolVersion": message["params"]["protocolVersion"],
                      "serverInfo": {"name": "fixture", "version": "1"}, "capabilities": {"tools": {}}}
        elif method == "tools/list":
            result = {"tools": [{"name": "echo_fixture", "description": "Synthetic fixture",
                                 "inputSchema": {"type": "object", "properties": {}}}]}
        elif method == "tools/call":
            assert message["params"]["name"] == "echo_fixture", message
            result = {"content": [{"type": "text", "text": "LAN_TOOL_OK"}]}
        else:
            raise AssertionError(method)
        self.reply(200, {"jsonrpc": "2.0", "id": message["id"], "result": result})

    def model(self, body):
        assert self.headers["Authorization"] == "Bearer synthetic-model-key"
        tool_results = [entry for entry in body["messages"] if entry["role"] == "tool"]
        if tool_results:
            assert "LAN_TOOL_OK" in str(tool_results[-1]["content"]), tool_results
            Server.model_received_tool = True
            delta, finish = {"role": "assistant", "content": "MCP_TOOL_FINISHED"}, "stop"
        else:
            assert TOOL in [tool["function"]["name"] for tool in body["tools"]], body["tools"]
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "type": "function", "id": "fixture_call",
                      "function": {"name": TOOL, "arguments": "{}"}}]}
            finish = "tool_calls"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for chunk, reason in ((delta, None), ({}, finish)):
            event = {"id": "model-fixture", "object": "chat.completion.chunk", "created": 1, "model": body["model"],
                     "choices": [{"index": 0, "delta": chunk, "finish_reason": reason}]}
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


def run(binary):
    with (tempfile.TemporaryDirectory(prefix="codey-mcp-lan-") as temp,
          ThreadingHTTPServer(("127.0.0.1", 0), Server) as server,
          ThreadingHTTPServer(("127.0.0.1", 0), Proxy) as proxy):
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        agent = home / ".codey/agent"
        agent.mkdir(mode=0o700, parents=True)
        project.mkdir()
        legacy = agent / "mcp.json"
        legacy.write_text('{"mcpServers": {}}\n')
        answers, queries = root / "answers.json", root / "queries"
        local = {"address": "127.0.0.1", "family": 4}
        public = {"address": "192.0.2.10", "family": 4}
        answers.write_text(json.dumps([local]))
        host = f"nas.local:{server.server_port}"
        model_base = f"http://127.0.0.1:{server.server_port}"
        endpoint = f"http://{host}/mcp"
        proxy_url = f"http://127.0.0.1:{proxy.server_port}"
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "api": "openai-completions", "apiKey": "synthetic-model-key", "baseUrl": model_base + "/v1",
            "models": [{"id": "fixture-model"}],
        }}}))
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color", "NO_COLOR": "1",
               "NODE_OPTIONS": f"--import={(HERE / 'fixtures/provider-lan-resolver.mjs').as_uri()}",
               "CODEY_TEST_DNS_ANSWERS": str(answers), "CODEY_TEST_DNS_LOG": str(queries),
               "HTTP_PROXY": proxy_url, "NODE_USE_ENV_PROXY": "1", "NO_PROXY": "127.0.0.1"}
        for httpd in (server, proxy):
            Thread(target=httpd.serve_forever, daemon=True).start()

        subprocess.run(["node", "-e", f'fetch("http://{host}").catch(() => {{}})'],
                       cwd=project, env=env, check=True, timeout=10)
        assert Proxy.seen in ([(host, None)], [(f"http://{host}/", None)]), Proxy.seen
        Proxy.seen.clear()

        def spawn():
            tty = pexpect.spawn(binary, ["--no-session", "--offline", "--provider", "fixture", "--model", "fixture-model"],
                                cwd=project, env=env, encoding="utf-8", timeout=25, dimensions=(50, 200))
            if os.environ.get("CODEY_TEST_TTY_LOG"):
                tty.logfile_read = sys.stdout
            tty.expect_exact("\x1b[?2026l")
            time.sleep(.75)
            return tty

        def add(tty, name, address, approve=None):
            enter(tty, "/mcp add")
            tty.expect_exact("New direct MCP server name")
            enter(tty, name)
            tty.expect_exact("MCP endpoint (HTTPS or local unauthenticated HTTP; no credentials or query)")
            enter(tty, address)
            if approve is not None:
                tty.expect_exact(f"Endpoint: {address}")
                tty.expect_exact("Tool arguments and results travel without encryption.")
                enter(tty, down=approve)

        def quit(tty):
            enter(tty, "/quit")
            tty.expect(pexpect.EOF)
            tty.close()
            assert tty.exitstatus == 0

        saved = agent / "mcp-direct/local.json"
        with spawn() as tty:
            add(tty, "Local", endpoint, False)
            time.sleep(.3)
            assert not Server.requests and not queries.exists() and not saved.exists()
            add(tty, "Public", "http://192.0.2.10/mcp")
            tty.expect_exact("Use HTTPS for public endpoints.")
            add(tty, "Credentials", f"http://user:password@{host}/mcp")
            tty.expect_exact("Enter an HTTP URL without credentials, query, or fragment.")
            assert not Server.requests and not queries.exists()
            add(tty, "Redirect", model_base + "/redirect", True)
            tty.expect_exact("HTTP MCP redirects are disabled.")
            add(tty, "Auth", model_base + "/auth", True)
            tty.expect_exact("Use HTTPS for authenticated MCP.")
            assert {row[0] for row in Server.requests} == {"/redirect", "/auth"}
            assert not list((agent / "mcp-direct").glob("*.json"))
            add(tty, "Local", endpoint, True)
            tty.expect_exact('Added direct HTTP MCP server "Local".')
            time.sleep(.9)
            add(tty, "Loop", model_base + "/loop", True)
            tty.expect_exact('Added direct HTTP MCP server "Loop".')
            time.sleep(.9)
            assert stat.S_IMODE(saved.stat().st_mode) == 0o600
            assert json.loads(saved.read_text()) == {"name": "Local", "url": endpoint, "httpApprovedUrl": endpoint}
            enter(tty, "/mcp direct login Local")
            tty.expect_exact("Use HTTPS for authenticated MCP.")
            enter(tty, "/mcp bridge add")
            tty.expect_exact("New MCP bridge name")
            enter(tty, "BridgeHttp")
            tty.expect_exact("HTTPS MCP endpoint")
            enter(tty, endpoint)
            tty.expect_exact("Use /mcp add for unauthenticated local HTTP.")
            quit(tty)

        def reconnect(tty):
            # The first Return accepts Pi's server-name completion.
            enter(tty, "/mcp reconnect Local")
            time.sleep(.3)
            enter(tty)

        with spawn() as tty:
            reconnect(tty)
            tty.expect_exact('Reconnected to MCP server "Local" (connected · 1 tool).')
            enter(tty, "/mcp")
            tty.expect_exact("Manage MCP servers")
            enter(tty)
            tty.expect_exact("Local")
            enter(tty)
            tty.expect_exact("Exposure")
            tty.send("\x1b[B\x1b[B")
            enter(tty)
            tty.expect_exact("Exposure of Local")
            tty.expect_exact("direct")
            tty.send("\x1b[B\x1b[B")
            enter(tty)
            tty.send("\x1b")
            time.sleep(.3)
            tty.send("\x1b")
            time.sleep(.5)
            enter(tty, "Invoke the synthetic MCP tool.")
            tty.expect_exact("MCP_TOOL_FINISHED")
            assert Server.model_received_tool
            assert any(row[:3] == ("/mcp", "tools/call", host) for row in Server.requests)

            for blocked in ([local, public], [public]):
                answers.write_text(json.dumps(blocked))
                before = len(Server.requests)
                lookups = len(queries.read_text().splitlines())
                reconnect(tty)
                deadline = time.monotonic() + 10
                while len(queries.read_text().splitlines()) == lookups and time.monotonic() < deadline:
                    time.sleep(.05)
                assert len(queries.read_text().splitlines()) > lookups
                tty.expect_exact("The HTTP hostname did not resolve exclusively to private or loopback addresses.")
                assert len(Server.requests) == before
            answers.write_text(json.dumps([local]))
            reconnect(tty)
            tty.expect_exact('Reconnected to MCP server "Local" (connected · 1 tool).')
            quit(tty)

        def rpc_status(message):
            with pexpect.spawn(binary, ["--mode", "rpc", "--no-session", "--offline"], cwd=project,
                               env=env, encoding="utf-8", timeout=25) as rpc:
                rpc.setecho(False)
                rpc.sendline(json.dumps({"id": "mcp", "type": "prompt", "message": "/mcp"}))
                rpc.expect_exact(message)
                rpc.sendeof()
                rpc.expect(pexpect.EOF)

        count = len(Server.requests)
        rpc_status("No MCP servers configured.")
        assert len(Server.requests) == count
        assert legacy.read_text() == '{"mcpServers": {}}\n'
        assert all(all(value is None for value in headers) for _, _, _, headers in Server.requests)
        assert {row[0] for row in Server.requests} == {"/mcp", "/loop", "/redirect", "/auth"}

        manual = json.dumps({"mcpServers": {"Manual": {"url": model_base + "/legacy",
                            "headers": {"Authorization": "Bearer synthetic-legacy-key"}}}})
        legacy.write_text(manual)
        rpc_status("Manual: connected, 1 tools")
        assert legacy.read_text() == manual
        assert Server.requests[count:] and all(
            path == "/legacy" and headers == ["Bearer synthetic-legacy-key", None, None]
            for path, _, _, headers in Server.requests[count:]
        )
        assert not Proxy.seen, Proxy.seen
        print("PASS /mcp add, no HTTP/DNS on cancel, tool result via real TUI, HTTP auth/redirect refused, restart/reconnect, mixed/public DNS, proxy bypass, RPC isolation and legacy config.")
        for httpd in (server, proxy):
            httpd.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).resolve()))
