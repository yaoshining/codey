"""Exercise the user-only worktree manager in the public macOS sandbox CLI."""

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

import pexpect


FakeModel = runpy.run_path(str(Path(__file__).with_name("integration.py")))["FakeModel"]


def main(binary):
    with tempfile.TemporaryDirectory(prefix="codey-worktree-test-") as temp, ThreadingHTTPServer(("127.0.0.1", 0), FakeModel) as server:
        root = Path(temp).resolve()
        home, source = root / "fixture home", root / "project with spaces"
        agent, pool = home / ".codey/agent", home / ".codey/worktrees"
        agent.mkdir(parents=True)
        source.mkdir()
        env = {"PATH": os.environ["PATH"], "HOME": str(home), "TERM": "xterm-256color",
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {"api": "openai-completions",
            "apiKey": "test-only", "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "models": [{"id": "fixture"}]}}}))

        def git(*args, cwd=source):
            return subprocess.check_output(["/usr/bin/git", *args], cwd=cwd, env=env, text=True).strip()

        git("init", "-qb", "main")
        (source / "tracked").write_text("committed\n")
        (source / ".gitignore").write_text("ignored\n")
        git("add", ".")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
        (source / "tracked").write_text("source edit\n")
        source_index = (source / ".git/index").read_bytes()
        ordinary = Path(__file__).resolve().parents[2] / "worktree.mjs"
        create_ordinary = f"import {{ createCheckout }} from {json.dumps(ordinary.as_uri())}; " + (
            "console.log(createCheckout({ task: 'legacy', base: 'HEAD' }, process.cwd()).path);"
        )
        existing = Path(subprocess.check_output(["node", "--input-type=module", "-e", create_ordinary],
                                                cwd=source, env=env, text=True).strip())
        args = ["--sandbox", "workspace-write", "--provider", "fixture", "--model", "fixture"]
        subprocess.run([binary, *args[:2], "--allow-domain", "codey-approval.example"], cwd=source, env=env, check=True)
        Thread(target=server.serve_forever, daemon=True).start()
        prompt = "codey-sandbox> "
        chooser = "Choose a number, or press Enter to cancel: "

        with pexpect.spawn(binary, args, cwd=source, env=env, encoding="utf-8", dimensions=(42, 180), timeout=35) as tty:
            tty.expect_exact(prompt)

            def send(line):
                tty.send(line + "\r")

            def command(line, expected):
                send(line)
                assert tty.expect_exact([expected, prompt]) == 0, tty.before
                tty.expect_exact(prompt)

            def switched():
                assert tty.expect_exact(["• Working directory changed to: ", prompt]) == 0, tty.before
                assert "\x1b[" in tty.before
                path = Path(tty.readline().split("\x1b", 1)[0].strip())
                tty.expect_exact(prompt)
                assert path.parent.parent == pool and path.name == source.name and path.is_dir()
                return path

            def new(option):
                send("/worktree")
                tty.expect_exact(chooser)
                send(str(option))
                return switched()

            def details(path):
                send("/worktree")
                tty.expect_exact(chooser)
                send("3")
                tty.expect_exact(chooser)
                listing = [line for line in tty.before.splitlines() if str(path) in line]
                assert len(listing) == 1, tty.before
                send(listing[0].strip().split(".", 1)[0])
                tty.expect_exact(chooser)
                return tty.before

            command("INITIAL_CHAT", "FAKE_MODEL_FINISHED")
            first = new(1)
            assert (first / "tracked").read_text() == "committed\n"
            assert (source / "tracked").read_text() == "source edit\n"
            command("CONTINUED_CHAT", "FAKE_MODEL_FINISHED")
            assert "INITIAL_CHAT" in json.dumps(FakeModel.requests[-1]["messages"])
            assert (first / "model-output").is_file()
            assert not any(t["function"]["name"] == "worktree" for t in FakeModel.requests[-1]["tools"])
            (first / ".codey").mkdir()
            (first / ".codey/protected").write_text("synthetic marker")
            nested = first / "folder/.CoDeY"
            nested.mkdir(parents=True)
            (nested / "protected").write_text("nested synthetic marker")
            source_q = shlex.quote(str(source))
            command(f"!![[ $(/bin/pwd) == {shlex.quote(str(first))} ]] && "
                    f"! /bin/cat {source_q}/tracked 2>/dev/null && ! /usr/bin/touch {source_q}/denied 2>/dev/null && "
                    "! /bin/cat .codey/protected 2>/dev/null && ! /bin/cat folder/.CoDeY/protected 2>/dev/null && "
                    "! /bin/cat .git 2>/dev/null && printf 'BOUNDARY_''OK'", "BOUNDARY_OK")
            assert not (source / "denied").exists()
            command("/review", "Linked worktrees are unavailable.")
            send("request granted read")
            tty.expect_exact("Network approval requested")
            tty.expect_exact(f"Working directory: {json.dumps(str(first))}")
            tty.expect_exact("or press Enter to deny:")
            send("")
            tty.expect_exact("UNEXPECTED_TOOL_RESULT")
            tty.expect_exact(prompt)
            assert not FakeModel.approved_reads
            assert "Delete worktree is unavailable" in details(first)
            send("1")
            result = tty.expect_exact(["Copied Worktree working directory to clipboard", "Copy the path manually: "])
            if result == 1:
                tty.expect_exact(str(first))
                print("PASS: headless clipboard failure offered the exact path to copy.", flush=True)
            tty.expect_exact(prompt)
            (first / ".codey/protected").unlink()
            (first / ".codey").rmdir()
            (nested / "protected").unlink()
            nested.rmdir()
            nested.parent.rmdir()

            second = new(2)
            command("FRESH_CHAT", "FAKE_MODEL_FINISHED")
            assert "INITIAL_CHAT" not in json.dumps(FakeModel.requests[-1]["messages"])
            assert "CONTINUED_CHAT" not in json.dumps(FakeModel.requests[-1]["messages"])
            assert second != first and (second / "model-output").is_file()
            assert "4. Delete worktree" in details(first)
            send("4")
            tty.expect_exact(chooser)
            send("2")
            tty.expect_exact("contains modified, untracked, or ignored files")
            tty.expect_exact(prompt)
            assert (first / "model-output").is_file()

            # Stale selections must keep both the active cwd and its copied state intact.
            details(first)
            pointer = (first / ".git").read_bytes()
            (first / ".git").write_text("gitdir: invalid\n")
            send("1")
            tty.expect_exact("target worktree is no longer registered")
            tty.expect_exact(prompt)
            (first / ".git").write_bytes(pointer)
            command("AFTER_FAILED_SWITCH", "FAKE_MODEL_FINISHED")
            assert "FRESH_CHAT" in json.dumps(FakeModel.requests[-1]["messages"])
            command("!!/bin/pwd", str(second))

            assert "Switch and copy this conversation" in details(existing)
            send("1")
            assert switched() == existing
            command("BROWSED_CHAT", "FAKE_MODEL_FINISHED")
            assert "FRESH_CHAT" in json.dumps(FakeModel.requests[-1]["messages"])
            assert "Switch with an empty conversation" in details(second)
            send("2")
            assert switched() == second
            command("BROWSED_FRESH_CHAT", "FAKE_MODEL_FINISHED")
            assert "BROWSED_CHAT" not in json.dumps(FakeModel.requests[-1]["messages"])

            (first / "model-output").unlink()
            (first / "ignored").write_text("keep\n")
            details(first)
            send("4")
            tty.expect_exact(chooser)
            send("2")
            tty.expect_exact("contains modified, untracked, or ignored files")
            tty.expect_exact(prompt)
            assert (first / "ignored").read_text() == "keep\n"
            (first / "ignored").unlink()

            details(first)
            send("4")
            tty.expect_exact(chooser)
            send("2")
            tty.expect_exact("Removed worktree at ")
            tty.expect_exact(prompt)
            assert not first.exists() and second.is_dir()

            git("config", "core.fsmonitor", "/usr/bin/false")
            send("/worktree")
            tty.expect_exact(chooser)
            send("1")
            tty.expect_exact("configuration is outside the supported worktree settings")
            tty.expect_exact(prompt)
            command("!!/bin/pwd", str(second))
            send("/quit")
            tty.expect(pexpect.EOF)
            tty.close()
            assert tty.exitstatus == 0
        assert (source / ".git/index").read_bytes() == source_index and (source / "tracked").read_text() == "source edit\n"
        print("PASS: public sandbox worktree create, copied and fresh chats, blocked old-root access and network grants, stale switch rollback and safe deletion.", flush=True)
        print("PASS: browsed and switched to an ordinary managed worktree, preserved or cleared the selected history, and kept the source index and edit.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main(str(Path(sys.argv[1]).absolute()))
