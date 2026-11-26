"""Exercise direct HTTPS add and OAuth through the ordinary Codey terminal."""

import json
import os
from pathlib import Path
import runpy
import ssl
import subprocess
import sys
import tempfile
import time
from http.server import ThreadingHTTPServer
from threading import Thread

import pexpect


fixtures = runpy.run_path(str(Path(__file__).with_name("mcp-bridge-oauth.integration.py")))
OAuth = fixtures["OAuth"]
openssl = os.environ.get("CODEY_TEST_OPENSSL", "/usr/bin/openssl")


class Direct(OAuth):
    requests = []

    def do_GET(self):
        self.requests.append(("GET", self.path, self.headers.get("Authorization")))
        return super().do_GET()

    def do_POST(self):
        self.requests.append(("POST", self.path, self.headers.get("Authorization")))
        if self.path == "/public":
            message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if "id" not in message:
                return self.reply(202)
            result = ({"protocolVersion": message["params"]["protocolVersion"],
                       "serverInfo": {"name": "public", "version": "1"}, "capabilities": {}}
                      if message["method"] == "initialize" else {"tools": []})
            return self.reply(200, {"jsonrpc": "2.0", "id": message["id"], "result": result})
        if self.path == "/redirect":
            return self.reply(307, Location=self.server.alias + "/public")
        if self.path == "/mcp" and not self.headers.get("Authorization"):
            self.rfile.read(int(self.headers["Content-Length"]))
            return self.reply(401, WWW_Authenticate=f'Bearer resource_metadata="{self.server.base}/resource-info", scope="projects:read"')
        return super().do_POST()


def certificate(root, name, san):
    key, cert, config = (root / (name + suffix) for suffix in (".key", ".pem", ".cnf"))
    config.write_text(f"[req]\ndistinguished_name=dn\n[dn]\n[fixture]\nsubjectAltName={san}\n")
    subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", f"/CN={name}", "-config", str(config), "-extensions", "fixture",
                    "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
    return cert, key


def dated_leaf(root, name, key, issuer_cert, issuer_key, self_signed=False):
    config, serial, database, request, cert = (root / (name + "-dated" + suffix) for suffix in (".cnf", ".serial", ".db", ".csr", ".pem"))
    config.write_text(f"""[ca]
default_ca=fixture
[fixture]
database={database}
serial={serial}
new_certs_dir={root}
default_md=sha256
policy=fixture_policy
[fixture_policy]
commonName=supplied
[leaf]
subjectAltName=IP:127.0.0.1
basicConstraints=critical,CA:FALSE
""")
    serial.write_text("01\n")
    database.touch()
    subprocess.run([openssl, "req", "-new", "-key", str(key), "-subj", f"/CN={name}",
                    "-out", str(request)], check=True, capture_output=True)
    validity = ["-startdate", "20000101000000Z", "-enddate", "20010101000000Z"] if self_signed else ["-days", "1"]
    subprocess.run([openssl, "ca", "-batch", "-notext", "-config", str(config), "-extensions", "leaf",
                    "-cert", str(issuer_cert), "-keyfile", str(issuer_key), "-in", str(request), "-out", str(cert),
                    *validity, *(["-selfsign"] if self_signed else [])], check=True, capture_output=True)
    return cert


def enter(tty, text="", down=False):
    if text:
        tty.send(text)
        time.sleep(.15)
    if down:
        tty.send("\x1b[B")
        time.sleep(.15)
    tty.send("\r")


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-direct-test-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Direct) as server:
        root = Path(temp).resolve()
        home, project, launchers = (root / name for name in ("home", "project", "bin"))
        agent = home / ".codey/agent"
        agent.mkdir(mode=0o700, parents=True)
        project.mkdir()
        launchers.mkdir()
        cert, key = certificate(root, "fixture", "IP:127.0.0.1,DNS:localhost")
        replacement, replacement_key = certificate(root, "replacement", "IP:127.0.0.1,DNS:localhost")
        wrong, wrong_key = certificate(root, "wrong", "DNS:localhost")
        renewed = root / "renewed.pem"
        subprocess.run([openssl, "req", "-x509", "-key", str(key), "-days", "1", "-set_serial", "42",
                        "-subj", "/CN=fixture", "-config", str(root / "fixture.cnf"), "-extensions", "fixture",
                        "-out", str(renewed)], check=True, capture_output=True)
        expired = dated_leaf(root, "fixture", key, cert, key, self_signed=True)
        issued = dated_leaf(root, "issued", replacement_key, cert, key)
        fingerprint = subprocess.check_output([openssl, "x509", "-in", str(cert),
                                               "-noout", "-sha256", "-fingerprint"], text=True).strip().split("=", 1)[1]
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        server.base = f"https://127.0.0.1:{server.server_port}"
        server.alias = f"https://localhost:{server.server_port}"
        server.browser_log = root / "browser.json"
        decision = root / "decision"
        decision.write_text("approve")
        for name in ("open", "xdg-open"):
            script = launchers / name
            script.write_text(fixtures["browser"].replace("#!PYTHON", f"#!{sys.executable}"))
            script.chmod(0o700)
        env = {"HOME": str(home), "PATH": f"{launchers}:{os.environ['PATH']}", "TERM": "xterm-256color", "NO_COLOR": "1",
               "FIXTURE_ISSUER": server.base, "FIXTURE_BROWSER_ORIGIN": server.base,
               "FIXTURE_BROWSER_LOG": str(server.browser_log), "FIXTURE_DECISION": str(decision)}
        saved = agent / "mcp-direct"
        legacy = agent / "mcp.json"
        legacy.write_text('{"mcpServers": {}}\n')
        Thread(target=server.serve_forever, daemon=True).start()

        def launch(options=env):
            return pexpect.spawn(binary, ["--no-session", "--offline"], cwd=project, env=options,
                                 encoding="utf-8", timeout=20, dimensions=(47, 190))

        def start(tty):
            tty.expect_exact("\x1b[?2026l")
            time.sleep(.75)

        def add(tty, name, path, menu=False):
            enter(tty, "/mcp" if menu else "/mcp add")
            if menu:
                tty.expect_exact("Add direct MCP server")
                enter(tty, down=True)
            tty.expect_exact("New direct MCP server name")
            enter(tty, name)
            tty.expect_exact("MCP endpoint (HTTPS or local unauthenticated HTTP; no credentials or query)")
            enter(tty, server.base + path)

        def quit(tty):
            time.sleep(.5)
            enter(tty, "/quit")
            tty.expect(pexpect.EOF)
            tty.close()
            assert tty.exitstatus == 0

        with launch() as tty:
            start(tty)
            add(tty, "CancelFixture", "/mcp", menu=True)
            tty.expect_exact("Verify the self-signed MCP certificate")
            tty.expect_exact(f"SHA-256: {fingerprint}")
            assert not Direct.requests
            enter(tty)
            assert not saved.exists()
            add(tty, "RotatedBeforeSave", "/mcp")
            tty.expect_exact("SHA-256:")
            tls.load_cert_chain(replacement, replacement_key)
            enter(tty, down=True)
            tty.expect_exact("Could not revalidate the confirmed certificate")
            assert not saved.exists() and not Direct.requests
            tls.load_cert_chain(wrong, wrong_key)
            add(tty, "WrongSAN", "/mcp")
            tty.expect_exact("certificate SAN must match")
            assert not saved.exists() and not Direct.requests
            tls.load_cert_chain(expired, key)
            add(tty, "Expired", "/mcp")
            tty.expect_exact("certificate is expired or not yet valid")
            tls.load_cert_chain(issued, replacement_key)
            add(tty, "IssuedByCA", "/mcp")
            tty.expect_exact("service leaf is not self-signed")
            assert not saved.exists() and not Direct.requests
            tls.load_cert_chain(cert, key)
            add(tty, "Pinned", "/mcp")
            tty.expect_exact("Fingerprint matches")
            assert not Direct.requests and not server.browser_log.exists()
            enter(tty, down=True)
            tty.expect_exact('Added "Pinned". Its MCP endpoint requires authentication.')
            tty.expect_exact("Open browser to sign in")
            assert Direct.requests == [("POST", "/mcp", None)]
            assert not server.browser_log.exists()
            enter(tty, down=True)
            tty.expect_exact("Waiting for browser approval")
            tty.expect_exact('Added and signed in to "Pinned".')
            quit(tty)
        record_path = saved / "pinned.json"
        record = json.loads(record_path.read_text())
        assert record["url"] == server.base + "/mcp" and record["pem"].strip() == cert.read_text().strip()
        assert record_path.stat().st_mode & 0o777 == 0o600
        assert OAuth.exchanges == OAuth.registrations == 1
        print("PASS: real /mcp add showed the verified fingerprint, canceled cleanly, rejected rotation, wrong SAN, expiry and a CA-issued leaf, then signed in with an approved self-signed leaf.", flush=True)

        def status(text):
            with pexpect.spawn(binary, ["--mode", "rpc", "--no-session", "--offline"], cwd=project, env=env,
                               encoding="utf-8", timeout=20) as rpc:
                rpc.setecho(False)
                rpc.sendline(json.dumps({"id": "mcp", "type": "prompt", "message": "/mcp"}))
                rpc.expect_exact(text)
                rpc.sendeof()
                rpc.expect(pexpect.EOF)

        status("Pinned: connected, 1 tools")
        OAuth.use_rotated = True
        status("Pinned: connected, 1 tools")
        assert OAuth.refreshes == 1
        tls.load_cert_chain(renewed, key)
        previous = len(Direct.requests)
        status("The saved MCP certificate no longer verifies.")
        assert len(Direct.requests) == previous and json.loads(record_path.read_text()) == record
        tls.load_cert_chain(cert, key)
        print("PASS: real direct transport reloaded the grant, refreshed with the scoped certificate, and refused a rotated server certificate.", flush=True)

        with launch({**env, "NODE_EXTRA_CA_CERTS": str(cert)}) as tty:
            start(tty)
            add(tty, "Trusted", "/public")
            tty.expect_exact('Added direct HTTPS MCP server "Trusted".')
            assert "SHA-256:" not in tty.before and "Open browser" not in tty.before
            add(tty, "Redirect", "/redirect")
            tty.expect_exact("Could not initialize the HTTPS MCP endpoint.")
            assert not (saved / "redirect.json").exists()
            quit(tty)
        assert json.loads((saved / "trusted.json").read_text())["pem"] == ""
        assert legacy.read_text() == '{"mcpServers": {}}\n'

        OAuth.external_issuer = True
        first_metadata = OAuth.metadata_reads
        server.browser_log.unlink()
        with launch() as tty:
            start(tty)
            enter(tty, "/mcp direct login Pinned")
            tty.expect_exact("Read OAuth issuer metadata from another HTTPS origin?")
            enter(tty, down=True)
            tty.expect_exact("Sign-in could not finish.")
            quit(tty)
        assert OAuth.metadata_reads == first_metadata and not server.browser_log.exists()
        assert OAuth.registrations == 1 and OAuth.exchanges == 1
        assert all(auth is None or path == "/mcp" for _, path, auth in Direct.requests)
        print("PASS: trusted TLS needed no fingerprint, redirects were blocked, and cross-origin OAuth did not inherit private certificate trust.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
