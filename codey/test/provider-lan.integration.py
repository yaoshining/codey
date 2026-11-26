"""Drive real /provider LAN requests with synthetic DNS, HTTP and proxy fixtures."""

import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pexpect


Gateway = runpy.run_path(str(Path(__file__).with_name("provider.integration.py")))["Gateway"]


class LanGateway(Gateway):
    hosts = []
    paths = []
    redirect = False

    def do_GET(self):
        self.hosts.append(self.headers["Host"])
        self.paths.append(self.path)
        super().do_GET()

    def do_POST(self):
        self.hosts.append(self.headers["Host"])
        self.paths.append(self.path)
        if self.redirect and self.path == "/chat/v1/chat/completions":
            self.send_response(307)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/unexpected")
            self.end_headers()
            return
        super().do_POST()


class Proxy(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        self.seen.append((self.path, self.headers.get("Authorization")))
        self.send_error(502)

    do_GET = do_POST = do_CONNECT


def run(binary):
    with (tempfile.TemporaryDirectory(prefix="codey-provider-lan-") as temp,
          ThreadingHTTPServer(("127.0.0.1", 0), LanGateway) as server,
          ThreadingHTTPServer(("127.0.0.1", 0), Proxy) as proxy):
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        agent = home / ".codey/agent"
        agent.mkdir(parents=True)
        project.mkdir()
        profile_file = agent / "custom-providers/lan-fixture.json"
        answers, queries = root / "dns.json", root / "queries"
        loopback = {"address": "127.0.0.1", "family": 4}
        public = {"address": "203.0.113.1", "family": 4}
        answers.write_text(json.dumps([loopback]))
        Thread(target=server.serve_forever, daemon=True).start()
        Thread(target=proxy.serve_forever, daemon=True).start()
        host = f"nas.local:{server.server_port}"
        endpoint = f"http://{host}/chat/v1"
        preload = Path(__file__).with_name("fixtures") / "provider-lan-resolver.mjs"
        proxy_url = f"http://127.0.0.1:{proxy.server_port}"
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color", "NO_COLOR": "1",
               "NODE_OPTIONS": f"--import={preload.resolve().as_uri()}", "NODE_USE_ENV_PROXY": "1", "HTTP_PROXY": proxy_url,
               "PI_SKIP_VERSION_CHECK": "1", "CODEY_TEST_DNS_ANSWERS": str(answers), "CODEY_TEST_DNS_LOG": str(queries)}
        subprocess.run(["node", "-e", f'fetch("http://{host}").catch(() => {{}})'], cwd=project, env=env, check=True, timeout=10)
        assert Proxy.seen == [(host, None)], Proxy.seen
        Proxy.seen.clear()

        log = io.StringIO()
        with pexpect.spawn(binary, ["--no-session", "--offline"], cwd=project, env=env,
                           encoding="utf-8", timeout=20, dimensions=(45, 170)) as tty:
            tty.logfile_read = log

            def enter(text="", down=0):
                if text:
                    tty.send(text)
                    time.sleep(.18)
                for _ in range(down):
                    tty.send("\x1b[B")
                    time.sleep(.08)
                tty.send("\r")

            def start(name):
                enter("/provider")
                tty.expect_exact("Add provider")
                enter()
                tty.expect_exact("New provider ID")
                enter(name)
                tty.expect_exact("Provider protocol")
                enter()
                tty.expect_exact("API Base URL")

            def edit():
                enter("/provider")
                tty.expect_exact("Edit provider or models")
                enter(down=1)
                tty.expect_exact("Choose saved provider")
                enter()
                tty.expect_exact("Provider protocol")
                enter()
                tty.expect_exact(endpoint[1:])

            tty.expect_exact("\x1b[?2026l")
            time.sleep(.9)
            start("cancelled")
            enter(endpoint)
            tty.expect_exact("Use unencrypted LAN HTTP?")
            tty.expect_exact("API keys, prompts, code, and responses are sent without encryption.")
            assert not Gateway.seen and not Proxy.seen and not queries.exists()
            enter()
            assert not profile_file.parent.exists()

            start("lan-fixture")
            enter(endpoint + "/")
            tty.expect_exact("Allow unencrypted HTTP for this Base URL")
            assert not Gateway.seen and not queries.exists()
            enter(down=1)
            tty.expect_exact("Provider authentication")
            enter()
            tty.expect_exact("API key (masked)")
            enter("fixture-lan-token")
            tty.expect_exact("Keep selections and continue")
            enter()
            tty.expect_exact("Select catalog models")
            tty.expect_exact("second")
            enter(down=1)
            tty.send("\x13")
            tty.expect_exact("1 selected")
            enter(down=3)
            tty.expect_exact("Save provider")
            enter(down=1)
            tty.expect_exact("Custom provider saved: lan-fixture.")
            raw = profile_file.read_bytes()
            assert json.loads(raw)["lanHttpApprovedUrl"] == endpoint
            assert [event[0] for event in Gateway.seen] == ["/chat/v1/models", "/chat/v1/models?after=first"]

            # Reuse the same process and URL. The next TCP connection must reject
            # a mixed result even though a usable address is listed first.
            answers.write_text(json.dumps([loopback, public]))
            old_queries = queries.read_text().splitlines()
            edit()
            enter()
            tty.expect_exact("Provider authentication")
            assert "Use unencrypted LAN HTTP?" not in tty.before
            enter()
            tty.expect_exact("Keep selections and continue")
            enter()
            tty.expect_exact("did not resolve exclusively to private or loopback addresses")
            assert queries.read_text().splitlines() == old_queries + ["nas.local"]
            assert len(Gateway.seen) == 2 and not Proxy.seen
            tty.send("\x03")
            time.sleep(.25)

            edit()
            tty.send("\x05\x15")
            time.sleep(.15)
            enter(endpoint.replace("/chat/", "/changed/"))
            tty.expect_exact("Use unencrypted LAN HTTP?")
            assert len(Gateway.seen) == 2 and queries.read_text().splitlines() == old_queries + ["nas.local"]
            enter()
            assert profile_file.read_bytes() == raw
            enter("/quit")
            tty.expect(pexpect.EOF)
        assert "fixture-lan-token" not in log.getvalue()
        print("PASS: real /provider cancel sent no requests, hostname discovery kept its Host, mixed DNS was blocked, and endpoint edits required fresh consent.", flush=True)

        def inference():
            return subprocess.run([binary, "--model", "lan-fixture/second", "-p", "fixture prompt"],
                                  cwd=project, env=env, capture_output=True, text=True, timeout=25)

        answers.write_text(json.dumps([loopback]))
        result = inference()
        assert result.returncode == 0 and "CHAT_OK" in result.stdout and "fixture-lan-token" not in result.stdout + result.stderr, result
        assert Gateway.seen[-1] == ("/chat/v1/chat/completions", "Bearer fixture-lan-token", None, "second")
        assert set(LanGateway.hosts) == {host} and not Proxy.seen
        count = len(LanGateway.hosts)
        old_queries = queries.read_text().splitlines()
        answers.write_text(json.dumps([public]))
        result = inference()
        assert "CHAT_OK" not in result.stdout and queries.read_text().splitlines() != old_queries
        assert len(LanGateway.hosts) == count and not Proxy.seen

        answers.write_text(json.dumps([loopback]))
        LanGateway.redirect = True
        result = inference()
        assert "CHAT_OK" not in result.stdout and len(LanGateway.hosts) > count
        assert set(LanGateway.paths[count:]) == {"/chat/v1/chat/completions"}, LanGateway.paths
        assert set(LanGateway.hosts) == {host} and not Proxy.seen
        LanGateway.redirect = False
        print("PASS: trusted profiles reloaded, inference stayed direct despite HTTP_PROXY, and public DNS and HTTP redirects sent no request to another address.", flush=True)

        if sys.platform == "darwin":
            args = ["--sandbox", "workspace-write", "--provider", "lan-fixture", "--model", "second"]
            with pexpect.spawn(binary, args, cwd=project, env=env, encoding="utf-8", timeout=25) as sandbox:
                sandbox.expect_exact("Model: lan-fixture/second")
                sandbox.expect_exact("codey-sandbox> ")
                sandbox.send("fixture host prompt\r")
                sandbox.expect_exact("CHAT_OK")
                sandbox.expect_exact("codey-sandbox> ")
                sandbox.send("/quit\r")
                sandbox.expect(pexpect.EOF)
            assert Gateway.seen[-1] == ("/chat/v1/chat/completions", "Bearer fixture-lan-token", None, "second")
            assert not Proxy.seen
            print("PASS: macOS Seatbelt host reused the approved LAN profile and did not use the configured proxy.", flush=True)

        before = queries.read_text()
        profile_file.write_text(json.dumps({**json.loads(raw), "baseUrl": endpoint.replace("/chat/", "/changed/")}))
        count = len(LanGateway.hosts)
        result = inference()
        assert "CHAT_OK" not in result.stdout and queries.read_text() == before
        assert len(LanGateway.hosts) == count and not Proxy.seen
        print("PASS: a saved URL changed without new approval could not send a request after restart.", flush=True)
        server.shutdown()
        proxy.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
