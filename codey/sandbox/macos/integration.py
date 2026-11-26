"""Drive the public macOS terminal with a synthetic worktree and a local fake model."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shlex
import shutil
import ssl
import subprocess
import sys
import tempfile
from threading import Event, Thread

import pexpect


class FakeModel(BaseHTTPRequestHandler):
    requests = []
    approved_reads = []
    review_mode = "success"
    review_gate = Event()

    def do_GET(self):
        if self.path in ("/approved", "/denied", "/timeout", "/granted", "/revoked", "/isolated", "/subdomain"):
            self.approved_reads.append(self.path)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"CONTROLLED_HTTPS_RESPONSE")
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"baseline")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        latest_user = max(i for i, m in enumerate(body["messages"]) if m["role"] == "user")
        latest_tools = [m for m in body["messages"][latest_user:] if m["role"] == "tool"]
        prompt = str(body["messages"][latest_user]["content"])
        if "Review the supplied Git patches" in str(body["messages"][0]["content"]):
            assert not body.get("tools") and latest_user == 1
            if self.review_mode == "error":
                self.send_error(400)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def chunk(delta, finish=None):
                payload = {"id": "review", "object": "chat.completion.chunk", "created": 1, "model": "fixture",
                           "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
                self.wfile.flush()

            try:
                chunk({"role": "assistant", "content": "P2 STREAMED_REVIEW_FIRST"})
                assert self.review_gate.wait(18)
                chunk({"content": " STREAMED_REVIEW_LAST", "tool_calls": [
                    {"index": 0, "type": "function", "id": "forbidden_write",
                     "function": {"name": "write", "arguments": '{"path":"review-must-not-write","content":"fixture"}'}},
                    {"index": 1, "type": "function", "id": "forbidden_network",
                     "function": {"name": "https_read", "arguments": '{"url":"https://codey-approval.example/approved"}'}},
                ]})
                chunk({}, "tool_calls")
                self.wfile.write(b"data: [DONE]\n\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        paths = ["approved", "denied", "timeout", "granted", "revoked", "isolated", "subdomain"]
        read_path = next((path for path in paths if f"request {path} read" in prompt), None)
        if read_path and not latest_tools:
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "type": "function", "id": f"fixture_{read_path}",
                "function": {"name": "https_read", "arguments": json.dumps({
                    "url": f"https://{'sub.' if read_path == 'subdomain' else ''}codey-approval.example/{read_path}"})},
            }]}
            finish = "tool_calls"
        elif read_path:
            content = str(latest_tools[-1]["content"])
            expected = "CONTROLLED_HTTPS_RESPONSE" if read_path in ("approved", "granted") else "HTTPS read was not approved."
            delta = {"role": "assistant", "content": "APPROVAL_FLOW_FINISHED" if expected in content else "UNEXPECTED_TOOL_RESULT"}
            finish = "stop"
        elif not latest_tools:
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "type": "function", "id": "fixture_write",
                "function": {"name": "write", "arguments": '{"path":"model-output","content":"model fixture"}'},
            }]}
            finish = "tool_calls"
        else:
            delta = {"role": "assistant", "content": "FAKE_MODEL_FINISHED"}
            finish = "stop"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event, reason in [(delta, None), ({}, finish)]:
            payload = {"id": "fixture", "object": "chat.completion.chunk", "created": 1, "model": "fixture",
                       "choices": [{"index": 0, "delta": event, "finish_reason": reason}]}
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


def main():
    binary = Path(sys.argv[1]).absolute()
    with (tempfile.TemporaryDirectory(prefix="codey-mac-test-") as temp,
          ThreadingHTTPServer(("127.0.0.1", 0), FakeModel) as server,
          ThreadingHTTPServer(("127.0.0.1", 0), FakeModel) as tls_server):
        Thread(target=server.serve_forever, daemon=True).start()
        root = Path(temp).resolve()
        home, source, linked = (root / name for name in ("fixture home", "main repo", "linked workspace"))
        source.mkdir()
        agent = home / ".codey/agent"
        agent.mkdir(parents=True)
        credentials = home / "host-only-marker"
        credentials.write_text("synthetic host marker")
        host_openssl_config = home / "openssl.cnf"
        host_openssl_config.write_text("# Synthetic host config\n")
        raw_config = {"providers": {"fixture": {"api": "openai-completions", "apiKey": "fixture",
                    "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                    "models": [{"id": "fixture"}]}}}
        (agent / "models.json").write_text(json.dumps(raw_config))
        env = {"PATH": os.environ["PATH"], "HOME": str(home), "TERM": "xterm-256color",
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
               "OPENAI_API_KEY": "credential-canary", "HTTPS_PROXY": "", "SSH_AUTH_SOCK": "agent-canary",
               "OPENSSL_CONF": str(host_openssl_config)}
        node_path = Path(shutil.which("node", path=env["PATH"])).resolve(strict=True)

        def git(*args, cwd=source):
            return subprocess.check_output(["/usr/bin/git", *args], cwd=cwd, env=env, text=True).strip()

        git("init", "-qb", "main")
        (source / "tracked").write_text("committed")
        git("add", ".")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
        git("worktree", "add", "-qb", "task", str(linked))
        (linked / "tracked").write_text("uncommitted")
        (linked / ".env").write_text("project secret marker")
        (linked / ".pi/extensions").mkdir(parents=True)
        (linked / ".pi/extensions/probe.ts").write_text(
            "import {writeFileSync} from 'node:fs'; writeFileSync(" + json.dumps(str(root / "unexpected-extension")) + ", 'ran');"
        )
        index = Path(git("rev-parse", "--path-format=absolute", "--git-path", "index", cwd=linked))
        old_index = index.read_bytes()
        quote = lambda p: shlex.quote(str(p))
        probe = f"http://127.0.0.1:{server.server_port}/probe"
        outside = root / "outside-write"
        baseline_commands = [
            f"/bin/cat {quote(credentials)} >/dev/null", "/bin/cat .env >/dev/null",
            f"/bin/cat {quote(host_openssl_config)} >/dev/null",
            f"/bin/cat {quote(index)} >/dev/null", f"/usr/bin/touch {quote(outside)}",
            f"/usr/bin/curl --silent --noproxy '*' --max-time 2 {probe} >/dev/null",
        ]
        subprocess.run(["/bin/bash", "--noprofile", "--norc", "-ec", " && ".join(baseline_commands)],
                       cwd=linked, env=env, check=True)
        assert outside.exists()
        outside.unlink()
        print("PASS: unsandboxed control could read host/project/Git markers, write outside, and connect to the local fixture.", flush=True)

        args = ["--sandbox", "workspace-write", "--provider", "fixture", "--model", "fixture"]
        with pexpect.spawn(str(binary), args, cwd=linked, env=env, encoding="utf-8", timeout=40) as terminal:
            if terminal.expect_exact(["codey-sandbox> ", pexpect.EOF]) == 1:
                raise SystemExit(f"Sandbox failed to start:\n{terminal.before}")

            def command(text, marker):
                terminal.send(text + "\r")
                terminal.expect_exact(marker)
                terminal.expect_exact("codey-sandbox> ")

            command("![[ $(/bin/cat tracked) == uncommitted ]] && printf 'typed-''output' > manual-output && printf 'MANUAL_''OK'", "MANUAL_OK")
            crypto = "process.env.OPENSSL_CONF === '/dev/null' && require('node:crypto').createHash('sha256').update('fixture').digest().length === 32"
            command(f"!{quote(node_path)} -e {quote(f'if (!({crypto})) process.exit(1)')} && printf 'OPENSSL_''OK'", "OPENSSL_OK")
            command("!!printf 'CONTEXT_''EXCLUDED'", "CONTEXT_EXCLUDED")
            command(f"!if /bin/cat {quote(credentials)} >/dev/null 2>&1; then exit 4; fi; "
                    f"if /bin/cat {quote(host_openssl_config)} >/dev/null 2>&1; then exit 4; fi; "
                    f"if /usr/bin/touch {quote(outside)} 2>/dev/null; then exit 4; fi; "
                    "if /bin/cat .env >/dev/null 2>&1; then exit 4; fi; "
                    "if printf bad >> .env; then exit 4; fi; "
                    f"if /bin/cat {quote(index)} >/dev/null 2>&1; then exit 4; fi; "
                    f"if /usr/bin/touch {quote(index.with_name('sandbox-denied-probe'))} 2>/dev/null; then exit 4; fi; "
                    f"if /usr/bin/curl --silent --noproxy '*' --max-time 2 {probe} >/dev/null; then exit 4; fi; "
                    "[[ -z $OPENAI_API_KEY && -z $HTTPS_PROXY && -z $SSH_AUTH_SOCK ]] && printf 'BOUNDARY_''OK'", "BOUNDARY_OK")
            for unavailable in ["/worktree", "/reload", "@tracked"]:
                command(unavailable, "unavailable in the macOS sandbox.")
            command("Use the fixture tool.", "FAKE_MODEL_FINISHED")
            terminal.send("/quit\r")
            terminal.expect(pexpect.EOF)
            terminal.close()
            assert terminal.exitstatus == 0

        assert (linked / "model-output").read_text() == "model fixture"
        assert (linked / "manual-output").read_text() == "typed-output"
        assert (linked / ".env").read_text() == "project secret marker"
        assert not outside.exists() and not index.with_name("sandbox-denied-probe").exists()
        assert not (root / "unexpected-extension").exists()
        assert index.read_bytes() == old_index
        assert (source / "tracked").read_text() == "committed"
        assert len(FakeModel.requests) == 2
        assert {t["function"]["name"] for t in FakeModel.requests[0]["tools"]} == {"read", "write", "edit", "bash", "ls", "https_read"}
        assert "CONTEXT_EXCLUDED" not in json.dumps(FakeModel.requests)
        assert "MANUAL_OK" in json.dumps(FakeModel.requests)
        print("PASS: the public terminal fenced manual commands and model writes; fake model and linked metadata verified.", flush=True)
        print("PASS: a worker child Node used the empty OpenSSL config and initialized SHA-256.", flush=True)

        (agent / "auth.json").write_text(json.dumps({"fixture": {"type": "api_key", "key": "!printf should-not-run"}}))
        with pexpect.spawn(str(binary), args, cwd=linked, env=env, encoding="utf-8", timeout=30) as terminal:
            terminal.expect_exact("Command-valued host auth.json is unsupported")
            terminal.expect(pexpect.EOF)
            terminal.close()
            assert terminal.exitstatus == 1
        assert len(FakeModel.requests) == 2
        print("PASS: executable credentials refused before any model request.", flush=True)

        (agent / "models.json").unlink()
        (agent / "auth.json").unlink()
        builtin_args = ["--sandbox", "workspace-write"]
        builtin_env = {key: value for key, value in env.items() if key != "OPENAI_API_KEY"}
        guidance = "Exit with /quit, run regular codey and use /login there, then reopen this sandbox."
        with pexpect.spawn(str(binary), builtin_args, cwd=linked, env=builtin_env, encoding="utf-8", timeout=30) as terminal:
            terminal.expect_exact("codey-sandbox> ")
            assert f"No models available. {guidance}" in terminal.before, terminal.before
            for text in ["/login", "A prompt without a model"]:
                terminal.send(text + "\r")
                terminal.expect_exact(guidance)
                assert "Use /login to log into" not in terminal.before
                terminal.expect_exact("codey-sandbox> ")
            terminal.send("/quit\r")
            terminal.expect(pexpect.EOF)
            terminal.close()
            assert terminal.exitstatus == 0

        for provider, credential in [
            ("openai", {"type": "api_key", "key": "fake-stored-key"}),
            ("openai-codex", {"type": "oauth", "access": "fake-access", "refresh": "fake-refresh", "expires": 0}),
        ]:
            (agent / "auth.json").write_text(json.dumps({provider: credential}))
            (agent / "settings.json").write_text(json.dumps({"defaultProvider": provider, "defaultModel": "gpt-6-luna"}))
            with pexpect.spawn(str(binary), builtin_args, cwd=linked, env=builtin_env, encoding="utf-8", timeout=30) as terminal:
                terminal.expect_exact("codey-sandbox> ")
                assert f"Model: {provider}/gpt-6-luna" in terminal.before, terminal.before
                terminal.send("/quit\r")
                terminal.expect(pexpect.EOF)
                terminal.close()
                assert terminal.exitstatus == 0
            assert json.loads((agent / "auth.json").read_text()) == {provider: credential}
        assert len(FakeModel.requests) == 2
        print("PASS: built-in model selection with stored API key and OAuth metadata, and login guidance without credentials.", flush=True)

        (agent / "models.json").write_text(json.dumps(raw_config))
        config, cert, key = (root / name for name in ("tls.cnf", "tls-cert", "tls-key"))
        config.write_text("[req]\ndistinguished_name=dn\n[dn]\n[fixture]\nsubjectAltName=DNS:codey-approval.example\n")
        subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=codey-approval.example", "-config", str(config), "-extensions", "fixture",
                        "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        tls_server.socket = context.wrap_socket(tls_server.socket, server_side=True)
        Thread(target=tls_server.serve_forever, daemon=True).start()
        wrapper_dir = root / "node-wrapper"
        wrapper_dir.mkdir()
        wrapper = wrapper_dir / "node"
        preload = binary.parent.parent / "test/fixtures/https-approval-local.mjs"
        wrapper.write_text(f'#!/bin/sh\nexec {quote(node_path)} --import {quote(preload)} "$@"\n')
        wrapper.chmod(0o700)
        approval_env = {**env, "PATH": f"{wrapper_dir}:{env['PATH']}",
                        "CODEY_FIXTURE_PORT": str(tls_server.server_port), "CODEY_FIXTURE_CERT": str(cert)}
        def domains(*flags, cwd=linked):
            return subprocess.check_output([str(binary), *builtin_args, *flags], cwd=cwd, env=env, text=True)

        assert "No HTTPS domains" in domains("--list-domains")
        with pexpect.spawn(str(binary), args, cwd=linked, env=approval_env, encoding="utf-8", timeout=45) as terminal:
            terminal.expect_exact("codey-sandbox> ")
            for path in ["denied", "approved", "timeout"]:
                terminal.send(f"request {path} read\r")
                url = f"https://codey-approval.example/{path}"
                terminal.expect_exact(f"Operation: HTTPS GET {url}")
                terminal.expect_exact(f"Working directory: {json.dumps(str(linked))}")
                terminal.expect_exact("Destination: codey-approval.example:443")
                terminal.expect(r"Type (approve [0-9a-f]{8}) to allow this request once")
                assert FakeModel.approved_reads == (["/approved"] if path == "timeout" else [])
                if path == "approved":
                    terminal.send(terminal.match.group(1) + "\r")
                elif path == "denied":
                    terminal.send("\r")
                terminal.expect_exact("APPROVAL_FLOW_FINISHED")
                terminal.expect_exact("codey-sandbox> ")
            domains("--allow-domain", "codey-approval.example")
            assert "codey-approval.example" == domains("--list-domains").strip()
            assert "No HTTPS domains" in domains("--list-domains", cwd=source)
            terminal.send("request granted read\r")
            terminal.expect_exact("APPROVAL_FLOW_FINISHED")
            assert "Network approval requested" not in terminal.before
            terminal.expect_exact("codey-sandbox> ")
            terminal.send("request subdomain read\r")
            terminal.expect_exact("Destination: sub.codey-approval.example:443")
            terminal.expect_exact("or press Enter to deny:")
            terminal.send("\r")
            terminal.expect_exact("APPROVAL_FLOW_FINISHED")
            terminal.expect_exact("codey-sandbox> ")
            domains("--remove-domain", "codey-approval.example")
            terminal.send("request revoked read\r")
            terminal.expect_exact("Operation: HTTPS GET https://codey-approval.example/revoked")
            terminal.expect_exact("or press Enter to deny:")
            terminal.send("\r")
            terminal.expect_exact("APPROVAL_FLOW_FINISHED")
            terminal.expect_exact("codey-sandbox> ")
            terminal.send("/quit\r")
            terminal.expect(pexpect.EOF)
            terminal.close()
            assert terminal.exitstatus == 0
        assert FakeModel.approved_reads == ["/approved", "/granted"]
        domains("--allow-domain", "codey-approval.example")
        with pexpect.spawn(str(binary), args, cwd=source, env=approval_env, encoding="utf-8", timeout=45) as terminal:
            terminal.expect_exact("codey-sandbox> ")
            terminal.send("request isolated read\r")
            terminal.expect_exact("Operation: HTTPS GET https://codey-approval.example/isolated")
            terminal.expect_exact("or press Enter to deny:")
            terminal.send("\r")
            terminal.expect_exact("APPROVAL_FLOW_FINISHED")
            terminal.expect_exact("codey-sandbox> ")
            terminal.send("/quit\r")
            terminal.expect(pexpect.EOF)
        assert FakeModel.approved_reads == ["/approved", "/granted"]
        print("PASS: fake model requested approval, only the approved call reached the controlled service, and the turn continued.", flush=True)
        print("PASS: exact domain applied to the canonical workspace, excluded subdomains and other workspaces, and revocation restored the prompt.", flush=True)

        review_started = ">> Code review started: current changes <<"
        review_finished = "<< Code review finished >>"
        with pexpect.spawn(str(binary), args, cwd=linked, env=env, encoding="utf-8", timeout=40) as terminal:
            terminal.expect_exact("codey-sandbox> ")
            terminal.send("/review\r")
            terminal.expect_exact("Linked worktrees are unavailable.")
            terminal.expect_exact(review_finished)
            terminal.expect_exact("codey-sandbox> ")
            terminal.send("/quit\r")
            terminal.expect(pexpect.EOF)

        with pexpect.spawn(str(binary), args, cwd=source, env=env, encoding="utf-8", timeout=40) as terminal:
            terminal.expect_exact("codey-sandbox> ")
            initial_count = len(FakeModel.requests)

            def start_review():
                terminal.send("/review\r")
                terminal.expect_exact(review_started)
                assert "\x1b[" in terminal.before

            def end_review(report=None):
                terminal.expect_exact(review_finished)
                if report:
                    assert report in terminal.before, terminal.before
                assert "\x1b[" in terminal.before and "Network approval requested" not in terminal.before
                terminal.expect_exact("codey-sandbox> ")

            start_review()
            terminal.expect_exact("No changes to review.")
            end_review()
            assert len(FakeModel.requests) == initial_count

            (source / "tracked").write_text("fixture staged line\n")
            git("add", "tracked")
            (source / "tracked").write_text("fixture unstaged line\n")
            (source / "new change").write_text("fixture untracked line\n")
            (source / ".git/info/exclude").write_text(".env\nignore-this\n")
            (source / "ignore-this").write_text("ignore-marker\n")
            (source / ".env").write_text("not-in-model-context\n")
            git("config", "diff.external", "/usr/bin/false")
            git("config", "filter.fixture.clean", "/usr/bin/false")
            (source / ".gitattributes").write_text("tracked filter=fixture\n")
            old_files = {path.name: path.read_bytes() for path in source.iterdir() if path.is_file()}
            review_index = (source / ".git/index").read_bytes()
            start_review()
            terminal.expect_exact("P2 STREAMED_REVIEW_FIRST")
            FakeModel.review_gate.set()
            terminal.expect_exact("STREAMED_REVIEW_LAST")
            end_review()
            assert len(FakeModel.requests) == initial_count + 1
            request = FakeModel.requests[-1]
            review_input = json.dumps(request["messages"])
            for marker in ("Staged changes", "Unstaged changes", "Untracked file", "fixture staged line",
                           "fixture unstaged line", "fixture untracked line"):
                assert marker in review_input, request
            for marker in ("ignore-marker", "not-in-model-context", str(source), "credential-canary"):
                assert marker not in review_input
            assert not request.get("tools")
            assert {path.name: path.read_bytes() for path in source.iterdir() if path.is_file()} == old_files
            assert (source / ".git/index").read_bytes() == review_index

            git("add", "-f", ".env")
            start_review()
            end_review("protected or unsupported file path")
            git("rm", "--cached", "-q", ".env")
            (source / "too-large").write_text("x" * 65537)
            start_review()
            end_review("exceeds the review size limit")
            (source / "too-large").unlink()
            (source / "linked-secret").symlink_to(credentials)
            start_review()
            end_review("regular files without links")
            (source / "linked-secret").unlink()
            assert len(FakeModel.requests) == initial_count + 1

            FakeModel.review_mode = "error"
            start_review()
            end_review("The model request failed.")
            FakeModel.review_mode = "success"
            FakeModel.review_gate.clear()
            start_review()
            terminal.expect_exact("P2 STREAMED_REVIEW_FIRST")
            terminal.sendcontrol("c")
            end_review("Code review canceled.")
            FakeModel.review_gate.set()
            terminal.send("Continue with the normal fixture tool.\r")
            terminal.expect_exact("FAKE_MODEL_FINISHED")
            terminal.expect_exact("codey-sandbox> ")
            terminal.send("/quit\r")
            terminal.expect(pexpect.EOF)
            terminal.close()
            assert terminal.exitstatus == 0
        assert not (source / "review-must-not-write").exists()
        assert not (source / ".gitignore").exists()
        assert FakeModel.approved_reads == ["/approved", "/granted"]
        assert "STREAMED_REVIEW_FIRST" not in json.dumps(FakeModel.requests[-1]["messages"])
        assert "fixture staged line" not in json.dumps(FakeModel.requests[-1]["messages"])
        print("PASS: real sandbox /review streams inline with brand markers, refuses unsafe input, sends no tools, and recovers from error and cancellation.", flush=True)
        tls_server.shutdown()
        server.shutdown()


if __name__ == "__main__":
    main()
