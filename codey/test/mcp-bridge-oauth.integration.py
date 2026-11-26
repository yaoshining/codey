"""Real /mcp bridge login against a synthetic TLS OAuth/MCP server and fake browser launcher."""

import base64
import hashlib
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
from urllib.parse import parse_qs

import pexpect


class OAuth(BaseHTTPRequestHandler):
    registrations = 0
    exchanges = 0
    refreshes = 0
    authorizations = 0
    grants = 0
    use_rotated = False
    external = False
    metadata_reads = 0

    def log_message(self, *args):
        pass

    def reply(self, status, body=None, **headers):
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        for name, value in headers.items():
            self.send_header(name.replace("_", "-"), value)
        self.end_headers()
        if body is not None:
            self.wfile.write(json.dumps(body).encode())

    def do_GET(self):
        if self.path == "/resource-info":
            issuer = f"https://localhost:{self.server.server_port}" if OAuth.external else self.server.base
            return self.reply(200, {"resource": self.server.base + "/mcp", "authorization_servers": [issuer],
                                    "scopes_supported": ["projects:read"]})
        if self.path == "/.well-known/oauth-authorization-server":
            OAuth.metadata_reads += 1
            return self.reply(200, {"issuer": self.server.base, "authorization_endpoint": self.server.base + "/authorize",
                                    "registration_endpoint": self.server.base + "/register", "token_endpoint": self.server.base + "/token",
                                    "response_types_supported": ["code"], "code_challenge_methods_supported": ["S256"],
                                    "token_endpoint_auth_methods_supported": ["none"], "authorization_response_iss_parameter_supported": True})
        if self.path == "/mcp":
            expected = "Bearer fixture-access-B" if OAuth.use_rotated else "Bearer fixture-access-A"
            if self.headers.get("Authorization") == expected:
                return self.reply(405)
            return self.reply(401, WWW_Authenticate=f'Bearer resource_metadata="{self.server.base}/resource-info", scope="projects:read"')
        return self.reply(404)

    def do_POST(self):
        request = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path == "/register":
            metadata = json.loads(request)
            assert metadata["redirect_uris"][0].startswith("http://127.0.0.1:")
            assert metadata["token_endpoint_auth_method"] == "none"
            OAuth.registrations += 1
            return self.reply(201, {**metadata, "client_id": "fixture-codey-client"})
        if self.path == "/token":
            fields = parse_qs(request.decode())
            assert fields["resource"] == [self.server.base + "/mcp"]
            assert fields["client_id"] == ["fixture-codey-client"]
            if fields["grant_type"] == ["authorization_code"]:
                proof = base64.urlsafe_b64encode(hashlib.sha256(fields["code_verifier"][0].encode()).digest()).decode().rstrip("=")
                approved = json.loads(self.server.browser_log.read_text())
                assert proof == approved["challenge"] and fields["redirect_uri"] == [approved["redirect"]]
                assert fields["code"] == ["fixture-code"]
                OAuth.exchanges += 1
                return self.reply(200, {"access_token": "fixture-access-A", "refresh_token": "fixture-refresh-A", "token_type": "Bearer", "expires_in": 3600})
            assert fields["grant_type"] == ["refresh_token"] and fields["refresh_token"] == ["fixture-refresh-A"]
            OAuth.refreshes += 1
            return self.reply(200, {"access_token": "fixture-access-B", "refresh_token": "fixture-refresh-B", "token_type": "Bearer", "expires_in": 3600})
        assert self.path == "/mcp"
        expected = "Bearer fixture-access-B" if OAuth.use_rotated else "Bearer fixture-access-A"
        if self.headers.get("Authorization") != expected:
            return self.reply(401, WWW_Authenticate=f'Bearer resource_metadata="{self.server.base}/resource-info", error="invalid_token"')
        message = json.loads(request)
        if "id" not in message:
            return self.reply(202)
        if message["method"] == "initialize":
            OAuth.grants += 1
            result = {"protocolVersion": message["params"]["protocolVersion"], "serverInfo": {"name": "fixture", "version": "1"}, "capabilities": {"tools": {}}}
        else:
            result = {"tools": [{"name": "list_projects", "inputSchema": {"type": "object"}}]}
        return self.reply(200, {"jsonrpc": "2.0", "id": message["id"], "result": result})


browser = r'''#!PYTHON
import json, os, sys
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen
url = urlsplit(sys.argv[1]); params = parse_qs(url.query)
assert f"{url.scheme}://{url.netloc}" == os.environ["FIXTURE_ISSUER"] and url.path == "/authorize"
assert params['code_challenge_method'] == ['S256'] and params['scope'] == ['projects:read']
redirect = params['redirect_uri'][0]
assert redirect.startswith('http://127.0.0.1:') and redirect.endswith('/callback')
Path(os.environ['FIXTURE_BROWSER_LOG']).write_text(json.dumps({"challenge": params['code_challenge'][0], "redirect": redirect}))
decision = Path(os.environ['FIXTURE_DECISION']).read_text()
if decision != 'wait':
    response = {'state': params['state'][0], 'iss': os.environ['FIXTURE_ISSUER']}
    response.update({'error': 'access_denied'} if decision == 'reject' else {'code': 'fixture-code'})
    with urlopen(redirect + '?' + urlencode(response), timeout=5) as callback:
        assert callback.status == 200
'''


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-mcp-oauth-bridge-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), OAuth) as server:
        root = Path(temp).resolve()
        home, project, launchers = (root / name for name in ("home", "project", "bin"))
        bridges = home / ".codey/agent/mcp-bridges"
        bridges.mkdir(mode=0o700, parents=True)
        project.mkdir()
        launchers.mkdir()
        key, cert, config = (root / name for name in ("fixture-key", "fixture.pem", "openssl.cnf"))
        config.write_text("[req]\ndistinguished_name=dn\n[dn]\n[fixture]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n")
        subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Fixture",
                        "-config", str(config), "-extensions", "fixture", "-keyout", str(key), "-out", str(cert)], capture_output=True, check=True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        server.base = f"https://127.0.0.1:{server.server_port}"
        server.browser_log = root / "browser.json"
        decision = root / "decision"
        (bridges / "fixture.json").write_text(json.dumps({"url": server.base + "/mcp", "pem": cert.read_text()}))
        for name in ["open", "xdg-open"]:
            launch = launchers / name
            launch.write_text(browser.replace("#!PYTHON", f"#!{sys.executable}"))
            launch.chmod(0o700)
        env = {"HOME": str(home), "PATH": f"{launchers}:{os.environ['PATH']}", "TERM": "xterm-256color", "NO_COLOR": "1",
               "FIXTURE_ISSUER": server.base, "FIXTURE_BROWSER_LOG": str(server.browser_log), "FIXTURE_DECISION": str(decision)}
        Thread(target=server.serve_forever, daemon=True).start()

        def launch_login(answer, expected):
            decision.write_text(answer)
            with pexpect.spawn(binary, ["--no-session", "--offline"], cwd=project, env=env, encoding="utf-8",
                               timeout=25, dimensions=(47, 170)) as tty:
                def enter(text="", down=False):
                    if text:
                        tty.send(text)
                        time.sleep(.2)
                    if down:
                        tty.send("\x1b[B")
                        time.sleep(.15)
                    tty.send("\r")
                tty.expect_exact("\x1b[?2026l")
                time.sleep(.9)
                assert not server.browser_log.exists()
                enter("/mcp bridge login")
                tty.expect_exact("Choose the MCP bridge")
                enter()
                tty.expect_exact("Discover OAuth for this MCP bridge?")
                enter()
                tty.expect_exact("OAuth issuer for this MCP bridge")
                enter(down=True)
                if answer == "external":
                    tty.expect_exact(expected)
                else:
                    tty.expect_exact("Approve OAuth endpoints for this MCP bridge")
                    start = OAuth.registrations
                    if answer == "before":
                        enter()
                        time.sleep(.35)
                        assert OAuth.registrations == start
                    else:
                        enter(down=True)
                        tty.expect_exact("Waiting for browser approval")
                        if answer == "wait":
                            tty.send("\x03")
                        tty.expect_exact(expected)
                enter("/quit")
                tty.expect(pexpect.EOF)
                tty.close()
                assert tty.exitstatus == 0
            server.browser_log.unlink(missing_ok=True)

        OAuth.external = True
        launch_login("external", "MCP bridge sign-in stopped.")
        OAuth.external = False
        assert OAuth.metadata_reads == OAuth.registrations == 0
        launch_login("before", "")
        assert OAuth.registrations == OAuth.exchanges == 0
        launch_login("wait", "MCP bridge sign-in cancelled.")
        launch_login("reject", "MCP bridge sign-in stopped.")
        assert OAuth.registrations == 2 and OAuth.exchanges == 0 and not list(bridges.glob(".oauth-*.json"))
        launch_login("approve", "MCP bridge signed in.")
        assert OAuth.registrations == 3 and OAuth.exchanges == 1
        grant, = bridges.glob(".oauth-*.json")
        assert grant.stat().st_mode & 0o777 == 0o600
        assert "codeVerifier" not in grant.read_text() and "oauthState" not in grant.read_text()
        print("PASS: real TUI consent, browser cancellation and refusal, pinned DCR, PKCE exchange, private grant, and CA origin isolation.", flush=True)

        def status():
            with pexpect.spawn(binary, ["--mode", "rpc", "--no-session", "--offline"], cwd=project, env=env, encoding="utf-8", timeout=25) as rpc:
                rpc.setecho(False)
                rpc.sendline(json.dumps({"id": "mcp", "type": "prompt", "message": "/mcp"}))
                rpc.expect_exact("fixture: connected, 1 tools")
                output = rpc.before + rpc.after + rpc.readline()
                assert "fixture-access" not in output and "fixture-refresh" not in output
                rpc.sendeof()
                rpc.expect(pexpect.EOF)

        before = OAuth.grants
        status()
        assert OAuth.grants > before and OAuth.refreshes == 0, (before, OAuth.grants, OAuth.refreshes)
        OAuth.use_rotated = True
        status()
        assert OAuth.refreshes == 1
        before = OAuth.grants
        status()
        assert OAuth.grants > before and OAuth.refreshes == 1
        assert json.loads(grant.read_text())["tokens"]["refresh_token"] == "fixture-refresh-B"
        assert not (home / ".codey/agent/mcp-auth.json").exists()
        print("PASS: grant resumed after restart, refreshed on 401 and reused the rotated token on the next restart.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
