"""Exercise the real Codey MCP terminal with two synthetic loopback TLS identities."""

import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pexpect


class Fixture(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.requests.append((self.path, "GET", self.headers.get("Authorization")))
        self.send_error(405)

    def do_POST(self):
        message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        auth = self.headers.get("Authorization")
        self.requests.append((self.path, message["method"], auth))
        if self.path == "/unauthorized" or (self.path == "/bridge" and auth != "Bearer bridge-fixture-key"):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Bearer resource_metadata="/no-discovery"')
            self.end_headers()
            self.wfile.write(b"untrusted remote error detail: bridge-fixture-key")
            return
        if self.path == "/redirect":
            self.send_response(307)
            self.send_header("Location", "/no-redirect")
            self.end_headers()
            return
        if "id" not in message:
            assert self.headers.get("MCP-Protocol-Version")
            self.send_response(202)
            self.end_headers()
            return
        if message["method"] == "initialize":
            result = {
                "protocolVersion": message["params"]["protocolVersion"],
                "serverInfo": {"name": "bridge-fixture", "version": "1"},
                "capabilities": {"tools": {}},
            }
        else:
            assert self.headers.get("MCP-Protocol-Version")
            result = {"tools": [{"name": "list_projects", "inputSchema": {"type": "object"}}]}
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}).encode())


def make_cert(root, name):
    key, cert, config = (root / (name + suffix) for suffix in [".key", ".pem", ".cnf"])
    config.write_text("[req]\ndistinguished_name=dn\n[dn]\n[fixture]\nsubjectAltName=IP:127.0.0.1\n")
    subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", f"/CN={name}", "-config", str(config), "-extensions", "fixture",
                    "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
    return key, cert


def enter(terminal, text=""):
    if text:
        terminal.send(text)
        time.sleep(0.2)
    terminal.send("\r")


def quit_terminal(terminal):
    enter(terminal, "/quit")
    terminal.expect(pexpect.EOF)
    terminal.close()
    assert terminal.exitstatus == 0


def main():
    binary = Path(sys.argv[1]).absolute()
    with tempfile.TemporaryDirectory(prefix="codey-bridge-check-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as server:
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        agent = home / ".codey/agent"
        agent.mkdir(parents=True)
        project.mkdir()
        key, cert = make_cert(root, "trusted fixture")
        _, unrelated = make_cert(root, "unrelated fixture")
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        Thread(target=server.serve_forever, daemon=True).start()
        base = f"https://127.0.0.1:{server.server_port}"
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color", "NO_COLOR": "1",
               "NODE_EXTRA_CA_CERTS": str(cert), "FIXTURE_BEARER": "bridge-fixture-key"}
        saved = agent / "mcp-bridges"
        with pexpect.spawn(str(binary), ["--no-session", "--offline"], cwd=project, env=env,
                           encoding="utf-8", timeout=20, dimensions=(45, 170)) as terminal:
            terminal.expect_exact("\x1b[?2026l")
            time.sleep(0.8)
            enter(terminal, "/mcp bridge")
            terminal.expect_exact("Add Node bridge")
            enter(terminal)
            terminal.expect_exact("New MCP bridge name")
            enter(terminal, "bridge-live")
            terminal.expect_exact("HTTPS MCP endpoint")
            enter(terminal, base + "/bridge")
            terminal.expect_exact("Choose a verified public PEM for this endpoint")
            terminal.send("\x1b[B")
            enter(terminal)
            terminal.expect_exact("Absolute path to the verified public certificate PEM")
            enter(terminal, str(cert))
            terminal.expect_exact("Optional Bearer token environment variable name")
            enter(terminal, "FIXTURE_BEARER")
            terminal.expect_exact("Certificate SHA-256:")
            terminal.expect_exact("Trust and save this endpoint")
            assert not saved.exists()
            terminal.send("\x1b[B")
            enter(terminal)
            terminal.expect_exact("MCP bridge saved.")
            enter(terminal, "/mcp bridge add")
            terminal.expect_exact("New MCP bridge name")
            enter(terminal, "bridge-live")
            terminal.expect_exact("An MCP server or bridge already uses that name.")
            enter(terminal, "/mcp bridge add")
            terminal.expect_exact("New MCP bridge name")
            enter(terminal, "system-default")
            terminal.expect_exact("HTTPS MCP endpoint")
            enter(terminal, base + "/default")
            terminal.expect_exact("Use Node and system trust")
            enter(terminal)
            terminal.expect_exact("Optional Bearer token environment variable name")
            assert "Absolute path" not in terminal.before
            enter(terminal)
            terminal.expect_exact("Trust and save this endpoint")
            terminal.send("\x1b[B")
            enter(terminal)
            terminal.expect_exact("MCP bridge saved.")
            quit_terminal(terminal)
        bridge = saved / "bridge-live.json"
        assert json.loads(bridge.read_text())["url"] == base + "/bridge"
        assert "bridge-fixture-key" not in bridge.read_text()
        assert bridge.stat().st_mode & 0o777 == 0o600
        assert json.loads((saved / "system-default.json").read_text())["pem"] == ""
        print("PASS: real /mcp bridge TUI required explicit PEM confirmation and saved one private entry without the token.", flush=True)

        def seed(name, endpoint, pem, token=""):
            path = saved / f"{name}.json"
            path.write_text(json.dumps({"url": endpoint, "pem": pem.read_text(), "tokenVariable": token}))
            path.chmod(0o600)

        seed("untrusted", base + "/untrusted", unrelated)
        seed("wrong-san", f"https://localhost:{server.server_port}/wrong-san", cert)
        seed("oauth-needed", base + "/unauthorized", cert)
        seed("redirect", base + "/redirect", cert, "FIXTURE_BEARER")
        (agent / "mcp.json").write_text(json.dumps({"mcpServers": {"direct-http": {"url": base + "/direct", "headers": {"Authorization": "Bearer direct-only"}}}}))
        with pexpect.spawn(str(binary), ["--mode", "rpc", "--no-session", "--offline"], cwd=project,
                           env=env, encoding="utf-8", timeout=25) as rpc:
            rpc.setecho(False)
            rpc.sendline(json.dumps({"id": "mcp", "type": "prompt", "message": "/mcp"}))
            rpc.expect_exact("bridge-live: connected")
            report = rpc.before + rpc.after + rpc.readline()
            assert "bridge-fixture-key" not in report, report
            assert "bridge-live: connected, 1 tools" in report and "direct-http: connected, 1 tools" in report, report
            assert "system-default: connected, 1 tools" in report, report
            assert "MCP bridge TLS identity mismatch" in report and "MCP bridge TLS certificate is untrusted" in report, report
            assert "MCP bridge authentication failed." in report and "Run /mcp bridge login" in report, report
            children = subprocess.check_output(["ps", "-axo", "pid=,ppid=,command="], text=True)
            child_pids = []
            for line in children.splitlines():
                pid, parent, command = line.strip().split(maxsplit=2)
                if int(parent) == rpc.pid and "mcp-bridge-child.mjs" in command:
                    assert "bridge-fixture-key" not in command
                    child_pids.append(int(pid))
            assert len(child_pids) == 2, child_pids
            rpc.sendeof()
            rpc.expect(pexpect.EOF)
            rpc.close()
            assert rpc.exitstatus == 0
        for pid in child_pids:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            raise AssertionError(f"Bridge child {pid} did not exit")
        assert ("/bridge", "tools/list", "Bearer bridge-fixture-key") in Fixture.requests
        assert ("/direct", "tools/list", "Bearer direct-only") in Fixture.requests
        assert ("/default", "tools/list", None) in Fixture.requests
        assert ("/unauthorized", "initialize", None) in Fixture.requests
        assert not any(path in ("/untrusted", "/wrong-san", "/no-discovery", "/no-redirect") for path, _, _ in Fixture.requests)
        assert all(auth != "Bearer bridge-fixture-key" or path in ("/bridge", "/redirect") for path, _, auth in Fixture.requests)
        without_extra = {key: value for key, value in env.items() if key != "NODE_EXTRA_CA_CERTS"}
        with pexpect.spawn(str(binary), ["--mode", "rpc", "--no-session", "--offline"], cwd=project,
                           env=without_extra, encoding="utf-8", timeout=25) as rpc:
            rpc.setecho(False)
            rpc.sendline(json.dumps({"id": "tls", "type": "prompt", "message": "/mcp"}))
            rpc.expect_exact("system-default: failed")
            report = rpc.after + rpc.readline()
            assert "configure a verified public PEM for this bridge" in report, report
            rpc.sendeof()
            rpc.expect(pexpect.EOF)
        print("PASS: bridge and ordinary direct transport listed tools; TLS failures, OAuth 401, no redirects, and child exit checked.", flush=True)
        print("PASS: normal Node trust skipped the PEM field and connected; removing synthetic trust reproduced certificate rejection.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
