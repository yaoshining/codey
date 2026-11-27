"""Check that Pi's program-resume integration reopens Codey with the original profile."""

import base64
import json
import os
import shlex
import sys
import tempfile
import time
import uuid
from pathlib import Path

import pexpect


def run(binary):
    with tempfile.TemporaryDirectory(prefix="codey-resume-") as temp:
        root = Path(temp).resolve()
        home, project, agent, sessions = (root / name for name in ("home", "project", "custom agent", "custom sessions"))
        for directory in (home, project, agent, sessions):
            directory.mkdir()
        session_id = str(uuid.uuid4())
        stamp = "2026-01-01T00:00:00.000Z"
        session = sessions / "fixture.jsonl"
        session.write_text("\n".join(map(json.dumps, [
            {"type": "session", "version": 3, "id": session_id, "timestamp": stamp, "cwd": str(project)},
            {"type": "message", "id": "fixture", "parentId": None, "timestamp": stamp,
             "message": {"role": "user", "content": "CODEY_RESUME_FIXTURE", "timestamp": 1767225600000}},
        ])) + "\n")
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color", "NO_COLOR": "1", "PI_OFFLINE": "1",
               "OSC7577_TOKEN": "codey-resume-test-token"}
        resume = ["codey", "--agent-dir", str(agent), "--session-dir", str(sessions), "--session", session_id]

        def launch(args):
            return pexpect.spawn(binary, args, cwd=project, env=env, encoding="utf-8", timeout=30, dimensions=(50, 160))

        def quit_terminal(tty):
            time.sleep(.4)
            tty.send("/quit")
            time.sleep(.15)
            tty.send("\r")

        with launch([*resume[1:], "--no-tools"]) as tty:
            tty.expect(r"\x1b\]7577;[^\x1b]+argv=([^:]+):cwd=([^:]+):mac=[0-9a-f]+\x1b\\")
            argv = [base64.b64decode(value).decode() for value in tty.match[1].split(",")]
            assert argv == [*resume, "--no-tools"], argv
            assert base64.b64decode(tty.match[2]).decode() == str(project)
            tty.expect_exact("\x1b[?2026l")
            quit_terminal(tty)
            tty.expect_exact("To resume this session:")
            tty.expect(r"\r?\n([^\r\n]+)")
            assert shlex.split(tty.match[1]) == resume
            tty.expect(pexpect.EOF)
        with launch(argv[1:]) as reopened:
            reopened.expect_exact("CODEY_RESUME_FIXTURE")
            reopened.expect_exact("\x1b[?2026l")
            quit_terminal(reopened)
            reopened.expect(pexpect.EOF)
        assert not (home / ".pi").exists()
        print("PASS: Codey branded OSC and exit resume, effective profile, original tool flag, and replayed session.")


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
