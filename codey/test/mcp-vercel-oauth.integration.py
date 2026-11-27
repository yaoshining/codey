"""Exercise renewable Vercel direct login against synthetic TLS and OAuth only."""

import base64
import hashlib
import json
import os
import runpy
import ssl
import sys
import tempfile
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs

import pexpect


direct = runpy.run_path(str(Path(__file__).with_name("mcp-direct.integration.py")))
OAuth = direct["OAuth"]
ISSUER = "https://vercel.com"
API = "https://api.vercel.com/login/oauth"
VERCEL = "https://mcp.vercel.com/"
OTHER = "https://mcp.fixture.invalid/"
DISCOVERY = "/.well-known/oauth-protected-resource"
METADATA = "/.well-known/oauth-authorization-server"


class Vercel(OAuth):
    def do_GET(self):
        host = self.headers["Host"]
        if host in ("mcp.vercel.com", "mcp.fixture.invalid") and self.path == DISCOVERY:
            assert not self.headers.get("Authorization")
            return self.reply(200, {"resource": f"https://{host}/", "authorization_servers": [ISSUER],
                                    "scopes_supported": ["openid"]})
        if host == "vercel.com" and self.path == METADATA:
            assert not self.headers.get("Authorization")
            return self.reply(200, self.server.metadata)
        return self.reply(405)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        host = self.headers["Host"]
        auth = self.headers.get("Authorization")
        fixture = self.server
        if host == "api.vercel.com":
            assert auth is None
            if self.path == "/login/oauth/register":
                record = json.loads(raw)
                assert record["scope"] == fixture.expected_scope
                assert record["grant_types"] == ["authorization_code", "refresh_token"]
                assert record["token_endpoint_auth_method"] == "none"
                fixture.registrations += 1
                client = f"synthetic-client-{fixture.registrations}"
                fixture.clients[client] = record
                return self.reply(201, {**record, "client_id": client})
            assert self.path == "/login/oauth/token"
            params = parse_qs(raw.decode())
            client = params["client_id"][0]
            resource = params["resource"][0]
            assert client in fixture.clients and resource in (VERCEL, OTHER)
            if params["grant_type"] == ["authorization_code"]:
                proof = base64.urlsafe_b64encode(hashlib.sha256(params["code_verifier"][0].encode()).digest()).decode().rstrip("=")
                browser = json.loads(fixture.browser.read_text())
                assert params["code"] == ["synthetic-code"] and proof == browser["challenge"]
                assert params["redirect_uri"] == fixture.clients[client]["redirect_uris"] == [browser["redirect"]]
                assert client == browser["client"] and resource == browser["resource"]
                fixture.exchanges += 1
                fixture.access[resource] = f"synthetic-access-{fixture.exchanges}"
                token = {"access_token": fixture.access[resource], "token_type": "Bearer",
                         "expires_in": 3600, "scope": fixture.expected_scope}
                if fixture.issue_refresh and fixture.expected_scope == "openid offline_access":
                    token["refresh_token"] = "synthetic-refresh-0"
                    fixture.refresh_client = client
                return self.reply(200, token)
            assert resource == VERCEL and client == fixture.refresh_client
            assert params["grant_type"] == ["refresh_token"]
            assert params["refresh_token"] == [f"synthetic-refresh-{fixture.refreshes}"]
            fixture.refreshes += 1
            fixture.access[resource] = f"synthetic-rotated-{fixture.refreshes}"
            return self.reply(200, {"access_token": fixture.access[resource], "token_type": "Bearer",
                                    "expires_in": 3600, "refresh_token": f"synthetic-refresh-{fixture.refreshes}"})
        assert self.path == "/" and host in ("mcp.vercel.com", "mcp.fixture.invalid")
        resource = f"https://{host}/"
        if auth is None or auth != f"Bearer {fixture.access.get(resource)}":
            return self.reply(401, WWW_Authenticate=f'Bearer resource_metadata="https://{host}{DISCOVERY}", scope="openid"')
        message = json.loads(raw)
        if "id" not in message:
            return self.reply(202)
        if message["method"] == "initialize":
            result = {"protocolVersion": message["params"]["protocolVersion"],
                      "serverInfo": {"name": "Synthetic MCP", "version": "1"}, "capabilities": {"tools": {}}}
        else:
            result = {"tools": [{"name": "list_projects", "inputSchema": {"type": "object"}}]}
        return self.reply(200, {"jsonrpc": "2.0", "id": message["id"], "result": result})


# TLS still verifies the fixture SANs, while every connection to a public-looking name is routed to loopback.
preload = """import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const connect = tls.connect;
const allowed = new Set(['mcp.vercel.com', 'vercel.com', 'api.vercel.com', 'mcp.fixture.invalid']);
tls.connect = (options, ...rest) => {
  if (!allowed.has(options.host) || options.port !== 443 || options.servername !== options.host) {
    throw new Error('External TLS blocked by fixture');
  }
  return connect({ ...options, host: '127.0.0.1', port: Number(process.env.FIXTURE_TLS_PORT) }, ...rest);
};
syncBuiltinESMExports();
"""


browser = r"""#!PYTHON
import json, os, sys
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen
url = urlsplit(sys.argv[1])
assert (url.scheme, url.netloc, url.path) == ('https', 'vercel.com', '/oauth/authorize')
params = parse_qs(url.query)
scope = os.environ['FIXTURE_SCOPE']
assert params['scope'] == [scope] and params['code_challenge_method'] == ['S256']
assert params.get('prompt') == (['consent'] if scope == 'openid offline_access' else None)
redirect = params['redirect_uri'][0]
assert redirect.startswith('http://127.0.0.1:') and redirect.endswith('/callback')
Path(os.environ['FIXTURE_BROWSER']).write_text(json.dumps({
    'challenge': params['code_challenge'][0], 'redirect': redirect, 'client': params['client_id'][0],
    'resource': params['resource'][0],
}))
query = {'state': params['state'][0], 'iss': 'https://vercel.com'}
query.update({'error': 'access_denied'} if os.environ['FIXTURE_DECISION'] == 'reject' else {'code': 'synthetic-code'})
with urlopen(redirect + '?' + urlencode(query), timeout=5) as reply:
    assert reply.status == 200
"""


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-vercel-test-") as tmp, ThreadingHTTPServer(("127.0.0.1", 0), Vercel) as server:
        root = Path(tmp).resolve()
        home, project, launchers = (root / name for name in ("home", "project", "bin"))
        saved = home / ".codey/agent/mcp-direct"
        saved.mkdir(mode=0o700, parents=True)
        project.mkdir()
        launchers.mkdir()
        cert, key = direct["certificate"](root, "synthetic", "DNS:mcp.vercel.com,DNS:vercel.com,DNS:api.vercel.com,DNS:mcp.fixture.invalid")
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        server.browser = root / "browser.json"
        server.registrations = server.exchanges = server.refreshes = 0
        server.clients, server.access = {}, {}
        server.issue_refresh = True
        server.metadata = {"issuer": ISSUER, "authorization_endpoint": ISSUER + "/oauth/authorize",
                           "registration_endpoint": API + "/register", "token_endpoint": API + "/token",
                           "response_types_supported": ["code"], "code_challenge_methods_supported": ["S256"],
                           "token_endpoint_auth_methods_supported": ["none"], "grant_types_supported": ["authorization_code", "refresh_token"],
                           "scopes_supported": ["openid", "offline_access", "email"], "authorization_response_iss_parameter_supported": True}
        preload_path = root / "preload.mjs"
        preload_path.write_text(preload)
        for name in ("open", "xdg-open"):
            launch = launchers / name
            launch.write_text(browser.replace("#!PYTHON", f"#!{sys.executable}"))
            launch.chmod(0o700)
        env = {"HOME": str(home), "PATH": f"{launchers}:{os.environ['PATH']}", "TERM": "xterm-256color",
               "NO_COLOR": "1", "FIXTURE_TLS_PORT": str(server.server_port), "FIXTURE_BROWSER": str(server.browser),
               "NODE_EXTRA_CA_CERTS": str(cert), "NODE_OPTIONS": f"--import={preload_path.as_uri()}"}

        def credentials(name, resource):
            profile = saved / f"{name.lower()}.json"
            profile.write_text(json.dumps({"name": name, "url": resource, "pem": ""}))
            profile.chmod(0o600)
            digest = hashlib.sha256(json.dumps([name.lower(), resource, ""], separators=(",", ":")).encode()).hexdigest()
            return saved / f".oauth-{digest}.json"

        grant = credentials("Vercel", VERCEL)
        grant.write_text(json.dumps({"serverUrl": VERCEL, "clientInformation": {"client_id": "legacy-client"},
                                     "tokens": {"access_token": "synthetic-legacy", "token_type": "Bearer", "scope": "openid"},
                                     "tokensExpireAt": 0}))
        grant.chmod(0o600)
        before = grant.read_bytes()
        Thread(target=server.serve_forever, daemon=True).start()

        def login(name, scope, action, *notices):
            server.expected_scope = scope
            server.browser.unlink(missing_ok=True)
            with pexpect.spawn(binary, ["--no-session", "--offline"], cwd=project, env={
                **env, "FIXTURE_SCOPE": scope, "FIXTURE_DECISION": action,
            }, encoding="utf-8", timeout=30, dimensions=(48, 190)) as tty:
                def enter(text="", down=False):
                    direct["enter"](tty, text, down)

                tty.expect_exact("\x1b[?2026l")
                time.sleep(.8)
                enter(f"/mcp direct login {name}")
                tty.expect_exact("Read OAuth issuer metadata from another HTTPS origin?")
                enter(down=True)
                tty.expect_exact("Allow these cross-origin OAuth destinations?")
                tty.expect_exact(f"Scope: {scope}")
                if scope == "openid offline_access":
                    tty.expect_exact("Vercel offline_access lets Codey renew")
                tty.expect_exact("\x1b[?2026l")
                assert not server.browser.exists()
                enter(down=action != "cancel")
                if notices:
                    tty.expect_exact("Waiting for browser approval")
                    for notice in notices:
                        tty.expect_exact(notice)
                time.sleep(.4)
                enter("/quit")
                tty.expect(pexpect.EOF)
                tty.close()
                assert tty.exitstatus == 0
            assert server.browser.exists() == (action != "cancel")

        login("Vercel", "openid offline_access", "cancel")
        assert server.registrations == server.exchanges == 0 and grant.read_bytes() == before
        login("Vercel", "openid offline_access", "reject", "Sign-in could not finish.")
        assert server.registrations == 1 and server.exchanges == 0 and grant.read_bytes() == before
        login("Vercel", "openid offline_access", "approve", 'Signed in to "Vercel".')
        state = json.loads(grant.read_text())
        assert state["tokens"]["refresh_token"] == "synthetic-refresh-0"
        assert state["clientInformation"]["client_id"] != "legacy-client"
        assert grant.stat().st_mode & 0o777 == 0o600

        for refresh in (1, 2):
            state["tokensExpireAt"] = 0
            grant.write_text(json.dumps(state))
            server.access[VERCEL] = "old-access-rejected"
            with pexpect.spawn(binary, ["--mode", "rpc", "--no-session", "--offline"], cwd=project, env=env,
                               encoding="utf-8", timeout=30) as rpc:
                rpc.setecho(False)
                rpc.sendline(json.dumps({"id": "mcp", "type": "prompt", "message": "/mcp"}))
                rpc.expect_exact("Vercel: connected, 1 tools")
                rpc.sendeof()
                rpc.expect(pexpect.EOF)
            state = json.loads(grant.read_text())
            assert server.refreshes == refresh and server.registrations == 2 and server.exchanges == 1
            assert state["tokens"]["scope"] == "openid offline_access"
            assert state["tokens"]["refresh_token"] == f"synthetic-refresh-{refresh}"
            assert grant.stat().st_mode & 0o777 == 0o600

        other = credentials("Other", OTHER)
        login("Other", "openid", "approve", 'Signed in to "Other".')
        assert "refresh_token" not in json.loads(other.read_text())["tokens"]
        server.issue_refresh = False
        login("Vercel", "openid offline_access", "approve",
              "Vercel did not issue a refresh token.", 'Signed in to "Vercel".')
        assert "refresh_token" not in json.loads(grant.read_text())["tokens"]
        server.metadata["grant_types_supported"] = ["authorization_code"]
        login("Vercel", "openid", "approve", 'Signed in to "Vercel".')
        assert json.loads(grant.read_text())["tokens"]["scope"] == "openid"
        print("PASS: direct Vercel OAuth upgraded a legacy grant and rotated twice after restart. Cancel, denial, other resources and unsupported issuers retained their scope boundaries.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
