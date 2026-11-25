"""Run the public sandbox CLI against a synthetic repository on a Docker test host."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

import pexpect

CANARY = """
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

assert.equal(process.cwd(), "/workspace");
assert.notEqual(process.getuid(), 0);
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.SSH_AUTH_SOCK, undefined);
const hostPaths = JSON.parse(readFileSync("host-canaries.json", "utf8"));
for (const path of [...hostPaths, ".git", "untracked", "ignored", "/var/run/docker.sock"])
	assert.equal(existsSync(path), false, path);
const processStatus = readFileSync("/proc/self/status", "utf8");
assert.match(processStatus, /^NoNewPrivs:\\s+1$/m);
assert.match(processStatus, /^CapEff:\\s+0+$/m);
assert.match(processStatus, /^Seccomp:\\s+2$/m);
const mountInfo = readFileSync("/proc/self/mountinfo", "utf8").split("\\n").map((line) => line.split(" "));
assert.ok(mountInfo.find((mount) => mount[4] === "/" && mount[5].split(",").includes("ro")));
assert.ok(mountInfo.find((mount) => mount[4] === "/workspace" && mount[5].split(",").includes("rw")));
const limits = "/sys/fs/cgroup/";
assert.equal(readFileSync(limits + "memory.max", "utf8").trim(), "1073741824");
assert.equal(readFileSync(limits + "memory.swap.max", "utf8").trim(), "0");
assert.equal(readFileSync(limits + "pids.max", "utf8").trim(), "128");
const [quota, period] = readFileSync(limits + "cpu.max", "utf8").trim().split(" ").map(Number);
assert.equal(quota / period, 1);
assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
await new Promise((resolve, reject) => {
	const socket = connect({ host: "192.0.2.1", port: 443 });
	socket.once("connect", () => { socket.destroy(); reject(new Error("Unexpected network connection")); });
	socket.once("error", (error) => error.code === "ENETUNREACH" ? resolve() : reject(error));
	socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Network check timed out")); });
});

const dir = process.env.HOME + "/.codey/agent";
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/models.json", JSON.stringify({ providers: { fixture: {
	baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fake",
	models: [{ id: "sandbox-faux" }],
} } }));
const fake = spawnSync("/opt/codey/codey/bin/codey", [
	"--offline", "--no-approve", "--no-session", "--provider", "fixture", "--model", "sandbox-faux", "-p", "fake prompt",
], { env: { ...process.env, NODE_OPTIONS: "--import=file:///opt/codey/packages/coding-agent/src/experimental/source-resolver.ts --import=file:///workspace/faux.mjs" },
	encoding: "utf8", timeout: 20_000 });
assert.equal(fake.status, 0, fake.stderr || fake.error?.message);
assert.match(fake.stdout, /synthetic sandbox reply/);
assert.equal(readFileSync("tracked", "utf8"), "committed\\n");
writeFileSync("tracked", "container edit\\n");
console.log("SANDBOX_CANARY_PASS");
"""

FAUX = """
import { ModelRuntime } from "/opt/codey/packages/coding-agent/src/core/model-runtime.ts";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "/opt/codey/packages/ai/src/index.ts";

ModelRuntime.prototype.streamSimple = function (model) {
	const stream = createAssistantMessageEventStream();
	const message = { ...fauxAssistantMessage("synthetic sandbox reply"), model: model.id, api: model.api, provider: model.provider };
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
};
"""


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("codey", type=Path, help="path to codey/bin/codey or installed Codey")
    parser.add_argument("image", help="local sandbox image ID")
    args = parser.parse_args()
    binary = args.codey.absolute()
    with tempfile.TemporaryDirectory(prefix="codey-sandbox-test-") as temp:
        root = Path(temp).resolve()
        repo, linked, home = (root / name for name in ("source repository", "linked checkout", "test home"))
        repo.mkdir()
        home.mkdir()
        host_canary = home / "host-only-canary"
        host_canary.write_text("host canary\n")
        env = {
            "PATH": os.environ["PATH"], "HOME": str(home), "TERM": "xterm-256color",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0",
            "OPENAI_API_KEY": "synthetic-host-canary", "SSH_AUTH_SOCK": str(home / "unused-agent.socket"),
        }

        def git(*command, cwd=repo):
            return subprocess.check_output(("git", *command), cwd=cwd, env=env, text=True)

        git("init", "-qb", "main")
        (repo / "tracked").write_text("committed\n")
        (repo / ".gitignore").write_text("ignored\n")
        (repo / "host-canaries.json").write_text(json.dumps([str(path) for path in [host_canary, repo, linked]]))
        (repo / "canary.mjs").write_text(CANARY)
        (repo / "faux.mjs").write_text(FAUX)
        git("add", ".")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
        git("worktree", "add", "-qb", "task", str(linked))
        (linked / "tracked").write_text("staged\n")
        git("add", "tracked", cwd=linked)
        (linked / "tracked").write_text("local-only\n")
        (linked / "untracked").touch()
        (linked / "ignored").touch()
        status = git("status", "--porcelain", cwd=linked)
        with pexpect.spawn(str(binary), ["sandbox", "--commit", "HEAD", "--image", args.image],
                           cwd=linked, env=env, encoding="utf-8", dimensions=(30, 140), timeout=45) as terminal:
            if terminal.expect_exact(["Press ctrl+o", pexpect.EOF]) == 1:
                raise SystemExit(f"Sandbox did not start:\n{terminal.before}")
            terminal.send("!node canary.mjs\r")
            terminal.expect_exact("SANDBOX_CANARY_PASS")
            terminal.send("/quit\r")
            terminal.expect(pexpect.EOF)
            terminal.close()
            assert terminal.exitstatus == 0
        result, = (home / ".codey" / "sandboxes").glob("task-*/project")
        assert (result / "tracked").read_text() == "container edit\n"
        assert (repo / "tracked").read_text() == "committed\n"
        assert (linked / "tracked").read_text() == "local-only\n"
        assert host_canary.read_text() == "host canary\n"
        assert git("status", "--porcelain", cwd=linked) == status
    print("Sandbox integration passed: contained edit, synthetic model, host isolation and denied network.")


if __name__ == "__main__":
    run()
