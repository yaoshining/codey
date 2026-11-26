"""Use Apple Git and the public sandbox terminal with normalized filenames."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unicodedata

import pexpect


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-unicode-test-") as temp:
        root = Path(temp).resolve()
        source, home = root / "fixture project", root / "fixture home"
        source.mkdir()
        home.mkdir()
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color",
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}

        def git(*args, cwd=source):
            return subprocess.check_output(["/usr/bin/git", *args], cwd=cwd, env=env, text=True)

        git("init", "-qb", "main")
        git("config", "core.precomposeunicode", "true")
        composed = "café.txt"
        decomposed = unicodedata.normalize("NFD", "résumé.txt")
        for name in (composed, decomposed):
            (source / name).write_text("tracked\n")
        (source / ".gitignore").write_text("ignored-*.txt\n")
        git("add", ".")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Unicode fixture")
        names = git("ls-files", "-z").split("\0")
        assert composed in names and unicodedata.normalize("NFC", decomposed) in names, names

        ordinary = Path(__file__).resolve().parents[2] / "worktree.mjs"
        script = f"import {{ createCheckout }} from {json.dumps(ordinary.as_uri())}; " + (
            "console.log(JSON.stringify(createCheckout({ task: process.argv[1], base: 'HEAD' }, process.cwd())));"
        )

        def create(task):
            return json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script, task],
                                                      cwd=source, env=env, text=True))

        current, target = create("unicode-current"), create("unicode-delete")
        current_path, target_path = (Path(entry["path"]) for entry in (current, target))
        config = (source / ".git/config").read_bytes()
        prompt = "codey-sandbox> "
        chooser = "Choose a number, or press Enter to cancel: "

        with pexpect.spawn(binary, ["--sandbox", "workspace-write"], cwd=source, env=env, encoding="utf-8",
                           dimensions=(42, 200), timeout=30) as tty:
            tty.expect_exact(prompt)

            def send(line):
                tty.send(line + "\r")

            def details(path):
                send("/worktree")
                tty.expect_exact(chooser)
                send("3")
                tty.expect_exact(chooser)
                rows = [line for line in tty.before.splitlines() if str(path) in line]
                assert len(rows) == 1, tty.before
                send(rows[0].strip().split(".", 1)[0])
                tty.expect_exact(chooser)
                return tty.before

            details(current_path)
            send("2")
            tty.expect_exact("Working directory changed to: ")
            tty.expect_exact(str(current_path))
            tty.expect_exact(prompt)
            table = "/usr/share/i18n/esdb/esdb.dir.db"
            assert os.access(table, os.R_OK)
            send(f"!!if ! /bin/cat {table} >/dev/null 2>&1; then printf 'MODEL_''WORKER_BLOCKED'; fi")
            tty.expect_exact(prompt)
            assert "MODEL_WORKER_BLOCKED" in tty.before, tty.before
            assert "Delete worktree is unavailable in the current checkout." in details(current_path)
            send("")
            tty.expect_exact(prompt)

            def delete(expect):
                assert "4. Delete worktree" in details(target_path)
                send("4")
                tty.expect_exact(chooser)
                send("2")
                tty.expect_exact(prompt)
                assert expect in tty.before, tty.before

            staged = target_path / composed
            staged.write_text("staged\n")
            git("add", "--", composed, cwd=target_path)
            assert git("status", "--porcelain", cwd=target_path).startswith("M ")
            delete("contains modified, untracked, or ignored files")
            assert staged.read_text() == "staged\n"
            git("restore", "--staged", "--worktree", "--", composed, cwd=target_path)

            for name, body in ((decomposed, "edited\n"), ("untracked-" + composed, "new\n"),
                               ("ignored-" + decomposed, "ignored\n")):
                path = target_path / name
                path.write_text(body)
                assert git("status", "--porcelain", "--untracked-files=all", "--ignored=matching", cwd=target_path)
                delete("contains modified, untracked, or ignored files")
                assert path.read_text() == body
                if name == decomposed:
                    path.write_text("tracked\n")
                else:
                    path.unlink()

            assert not git("status", "--porcelain", "--untracked-files=all", "--ignored=matching", cwd=target_path)
            delete("Removed worktree at ")
            assert not target_path.exists() and not Path(target["gitDir"]).exists()
            registrations = git("worktree", "list", "--porcelain", "-z").split("\0")
            assert f"worktree {target_path}" not in registrations and f"worktree {current_path}" in registrations
            assert git("show-ref", "--verify", f"refs/heads/{target['branch']}").strip()
            assert (source / ".git/config").read_bytes() == config
            send("/quit")
            tty.expect(pexpect.EOF)
            tty.close()
            assert tty.exitstatus == 0
        print("PASS: Apple Git preserved Unicode staged, modified, untracked, ignored and current worktrees, then removed a clean checkout and its registration.", flush=True)
        print("PASS: the normal tool worker could not read the Git management process's system conversion table.", flush=True)


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
