"""Exercise large and resumable model catalogs through the public /provider TUI."""

import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, urlsplit

import pexpect


EXACT = "openai/gpt-6.2-sol"
LOOKALIKE = "openrouter/" + EXACT
KEY = "catalog-fixture-key"


class Catalog(BaseHTTPRequestHandler):
    requests = []
    retry = True

    def log_message(self, *args):
        pass

    def do_GET(self):
        url = urlsplit(self.path)
        assert url.path in ("/large/v1/models", "/paginated/v1/models")
        assert self.headers["Authorization"] == f"Bearer {KEY}"
        self.requests.append(self.path)
        link = None
        if url.path.startswith("/large/"):
            rows = [{"id": f"model-{n:04}", "metadata": "x" * 800} for n in range(750)]
            data = {"data": [{"id": LOOKALIKE}, *rows, {"id": EXACT}, {"id": KEY}]}
        else:
            cursor = parse_qs(url.query).get("after", ["0"])[0]
            page = int(cursor)
            if page == 11 and Catalog.retry:
                Catalog.retry = False
                self.send_error(503)
                return
            rows = [{"id": f"model-{n:04}"} for n in range(page * 60, (page + 1) * 60)]
            data = {"data": [{"id": LOOKALIKE}, *rows]}
            if page == 11:
                data["data"] += [{"id": EXACT}, {"id": KEY}]
            elif page % 2 == 0:
                data.update(has_more=True, last_id=str(page + 1))
            else:
                link = f'<?after={page + 1}>; rel="next"'
        body = json.dumps(data).encode()
        if not url.query and url.path.startswith("/large/"):
            assert len(body) > 512 * 1024
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if link:
            self.send_header("Link", link)
        self.end_headers()
        self.wfile.write(body)


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-provider-catalog-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), Catalog) as server:
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        home.mkdir()
        project.mkdir()
        Thread(target=server.serve_forever, daemon=True).start()
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color", "NO_COLOR": "1",
               "PI_SKIP_VERSION_CHECK": "1"}
        transcript = io.StringIO()
        with pexpect.spawn(binary, ["--no-session", "--offline"], cwd=project, env=env,
                           encoding="utf-8", timeout=25, dimensions=(42, 170)) as tty:
            tty.logfile_read = transcript

            def enter(text="", down=0):
                if text:
                    tty.send(text)
                    time.sleep(.18)
                for _ in range(down):
                    tty.send("\x1b[B")
                    time.sleep(.08)
                tty.send("\r")

            tty.expect_exact("\x1b[?2026l")
            time.sleep(.9)
            for name in ("large", "paginated"):
                enter("/provider")
                tty.expect_exact("Add provider")
                enter()
                tty.expect_exact("New provider name")
                enter(name)
                tty.expect_exact("Provider protocol")
                enter()
                tty.expect_exact("API Base URL")
                enter(f"http://127.0.0.1:{server.server_port}/{name}/v1")
                tty.expect_exact("Provider authentication")
                enter()
                tty.expect_exact("API key (masked)")
                enter(KEY)
                tty.expect_exact("Keep selections and continue")
                enter()
                tty.expect_exact("Request the model catalog?")
                enter()
                if name == "paginated":
                    tty.expect_exact("Only 661 model IDs loaded.")
                    tty.expect_exact("Continue loading model catalog")
                    enter(down=1)

                tty.expect_exact("Select catalog models")
                tty.expect_exact("> [ ] " + LOOKALIKE)
                tty.send(EXACT)
                tty.expect_exact("> [ ] " + EXACT)
                tty.expect_exact("[ ] " + LOOKALIKE)
                enter()
                tty.send("\x13")
                tty.expect_exact("Keep selections and continue")
                enter(down=2)
                tty.expect_exact("Model IDs (one ID or a JSON array)")
                tty.send("\x05\x15")
                time.sleep(.15)
                enter(json.dumps([EXACT, "manually-entered"]))
                tty.expect_exact("Keep selections and continue")
                enter(down=3)
                tty.expect_exact("Save provider")
                enter(down=1)
                tty.expect_exact(f"Custom provider saved: {name}.")
                path = home / ".codey/agent/custom-providers" / f"{name}.json"
                assert json.loads(path.read_text())["models"] == [EXACT, "manually-entered"]
            enter("/quit")
            tty.expect(pexpect.EOF)
        assert KEY not in transcript.getvalue()
        assert Catalog.requests == ["/large/v1/models", "/paginated/v1/models",
                                    *[f"/paginated/v1/models?after={i}" for i in range(1, 12)],
                                    "/paginated/v1/models?after=11"], Catalog.requests
        print("PASS: real /provider found the exact ID beyond 500 on a large page and across 12 pages, resumed after HTTP 503, and saved only the chosen and manual IDs.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
