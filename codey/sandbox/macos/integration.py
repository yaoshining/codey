"""Drive the public macOS terminal with a synthetic worktree and a local fake model."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
from threading import Thread

import pexpect


class FakeModel(BaseHTTPRequestHandler):
    requests = []

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"baseline")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        if not any(m["role"] == "tool" for m in body["messages"]):
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
    with tempfile.TemporaryDirectory(prefix="codey-mac-test-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), FakeModel) as server:
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
            for unavailable in ["/review", "/worktree", "/reload", "@tracked"]:
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
        assert {t["function"]["name"] for t in FakeModel.requests[0]["tools"]} == {"read", "write", "edit", "bash", "ls"}
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
            terminal.expect_exact(f"No models available. {guidance}")
            terminal.expect_exact("codey-sandbox> ")
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
                terminal.expect_exact(f"Model: {provider}/gpt-6-luna")
                terminal.expect_exact("codey-sandbox> ")
                terminal.send("/quit\r")
                terminal.expect(pexpect.EOF)
                terminal.close()
                assert terminal.exitstatus == 0
            assert json.loads((agent / "auth.json").read_text()) == {provider: credential}
        assert len(FakeModel.requests) == 2
        print("PASS: built-in model selection with stored API key and OAuth metadata, and login guidance without credentials.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
