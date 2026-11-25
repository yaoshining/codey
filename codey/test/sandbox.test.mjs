// Exercise the public entry and isolated snapshot without a Docker daemon.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync,
	symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSnapshot, prepareSnapshot } from "../sandbox/snapshot.mjs";

const codey = fileURLToPath(new URL("../bin/codey", import.meta.url));
const image = `sha256:${"a".repeat(64)}`;
const canRunTty = process.platform === "linux" && process.getuid?.() && process.getgid?.() &&
	spawnSync("script", ["--version"]).status === 0;

function fixture(t) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "codey-snapshot-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const repo = join(dir, "main checkout");
	const home = join(dir, "test home");
	const bin = join(dir, "test bin");
	const linked = join(dir, "linked checkout");
	for (const path of [repo, home, bin]) mkdirSync(path);
	const env = {
		PATH: `${bin}:${process.env.PATH}`, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_OPTIONAL_LOCKS: "0", OPENAI_API_KEY: "SYNTHETIC_DO_NOT_FORWARD",
	};
	const git = (args, cwd = repo) => {
		const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git(["init", "-q", "-b", "main"]);
	git(["config", "user.name", "Fixture"]);
	git(["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(repo, "committed file"), "exact blob\n");
	writeFileSync(join(repo, ".gitignore"), "ignored\n");
	writeFileSync(join(repo, ".gitattributes"), "committed* export-ignore\n");
	writeFileSync(join(repo, "run test"), "#!/bin/sh\n", { mode: 0o755 });
	symlinkSync("committed file", join(repo, "inside link"));
	git(["add", "."]);
	git(["commit", "-qm", "base"]);
	git(["worktree", "add", "-qb", "task", linked]);
	return { repo, home, bin, linked, env, git };
}

test("dry run names the selected commit and all isolation flags without calling Docker or writing a snapshot", (t) => {
	const { home, bin, linked, env, git } = fixture(t);
	writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
	writeFileSync(join(linked, "committed file"), "unstaged\n");
	const result = spawnSync(codey, ["sandbox", "--commit", "HEAD", "--image", image, "--dry-run"], {
		cwd: linked, env, encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	const plan = JSON.parse(result.stdout);
	assert.equal(plan.commit, git(["rev-parse", "HEAD"], linked));
	assert.match(plan.scope, /Local changes.*excluded/);
	assert.equal(plan.files, 5);
	for (const flag of [
		"--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
		"--cpus=1", "--memory=1g", "--memory-swap=1g", "--pids-limit=128",
	]) assert.ok(plan.dockerArgs.includes(flag), flag);
	assert.equal(plan.dockerArgs.filter((arg) => arg === "--mount").length, 1);
	assert.match(plan.dockerArgs.join(" "), /target=\/workspace,bind-recursive=disabled/);
	assert.doesNotMatch(result.stdout, /SYNTHETIC_DO_NOT_FORWARD|docker\.sock/);
	assert.deepEqual(readdirSync(home), []);
});

test("linked checkout snapshot has exact committed bytes, a separate inode and no shared Git state", (t) => {
	const { repo, linked, home, git } = fixture(t);
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => { process.env.HOME = oldHome; });
	writeFileSync(join(linked, "committed file"), "staged\n");
	git(["add", "committed file"], linked);
	writeFileSync(join(linked, "committed file"), "unstaged\n");
	writeFileSync(join(linked, "untracked"), "outside scope");
	writeFileSync(join(linked, "ignored"), "outside scope");
	const status = git(["status", "--porcelain"], linked);
	const dotGit = readFileSync(join(linked, ".git"));
	const project = createSnapshot(prepareSnapshot(linked, "HEAD"));
	assert.equal(readFileSync(join(project, "committed file"), "utf8"), "exact blob\n");
	assert.equal(readlinkSync(join(project, "inside link")), "committed file");
	assert.ok(statSync(join(project, "run test")).mode & 0o100);
	assert.notEqual(statSync(join(project, "committed file")).ino, statSync(join(repo, "committed file")).ino);
	for (const excluded of [".git", "ignored", "untracked"]) assert.equal(existsSync(join(project, excluded)), false);
	writeFileSync(join(project, "committed file"), "task changed only\n");
	assert.equal(readFileSync(join(repo, "committed file"), "utf8"), "exact blob\n");
	assert.equal(readFileSync(join(linked, "committed file"), "utf8"), "unstaged\n");
	assert.deepEqual(readFileSync(join(linked, ".git")), dotGit);
	assert.equal(git(["status", "--porcelain"], linked), status);
});

test("a link to a host file is refused before any link is created", (t) => {
	const { repo, home, git } = fixture(t);
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => { process.env.HOME = oldHome; });
	writeFileSync(join(home, "host-only"), "host canary");
	symlinkSync("../../../host-only", join(repo, "host link"));
	git(["add", "host link"]);
	git(["commit", "-qm", "host link"]);
	assert.throws(() => createSnapshot(prepareSnapshot(repo, "HEAD")), /Snapshot incomplete.*outside the snapshot/);
	const pool = join(home, ".codey", "sandboxes");
	const [task] = readdirSync(pool);
	assert.equal(readdirSync(join(pool, task, "project")).some((file) => file.endsWith("link")), false);
	assert.equal(readFileSync(join(home, "host-only"), "utf8"), "host canary");
});

test("an unsafe daemon is refused before reading an image or generating a project", {
	skip: !canRunTty,
}, (t) => {
	const { home, bin, linked, env } = fixture(t);
	writeFileSync(join(bin, "docker"), `#!/bin/sh
if [ "$3" != info ] || [ -n "$OPENAI_API_KEY" ] || [ "$HOME" != /dev/null ]; then
  echo unexpected Docker invocation >&2
  exit 99
fi
printf '%s\\n' '"linux"' false false false false '["name=seccomp,profile=builtin"]'
`, { mode: 0o755 });
	const result = spawnSync("script", ["-qec", `"${codey}" sandbox --commit HEAD --image ${image}`, "/dev/null"], {
		cwd: linked, env, encoding: "utf8", timeout: 15_000,
	});
	assert.equal(result.status, 1, result.stdout);
	assert.match(result.stdout, /must report Linux, default seccomp.*No sandbox was started/);
	assert.deepEqual(readdirSync(home), []);
});

test("isolated Docker launch receives only the new writable project and retains it on failure", { skip: !canRunTty }, (t) => {
	const { home, bin, linked, env, git } = fixture(t);
	writeFileSync(join(bin, "docker"), `#!/bin/sh
[ "$1" = --host ] && [ "$2" = unix:///var/run/docker.sock ] || exit 99
[ -z "$OPENAI_API_KEY" ] && [ "$DOCKER_CONFIG" = /dev/null ] || exit 99
case "$3" in
  info) printf '%s\\n' '"linux"' true true true true '["name=seccomp,profile=builtin"]' ;;
  image) printf '%s\\n' '{"Id":"${image}","Os":"linux","Config":{"Labels":{"org.codey.sandbox":"offline-v1"}}}' ;;
  --config)
    while [ "$1" != --mount ] && [ "$#" -gt 0 ]; do shift; done
    [ "$#" -gt 0 ] || exit 99
    project=${'$'}{2#type=bind,source=}
    project=${'$'}{project%,target=/workspace,bind-recursive=disabled}
    [ -d "$project" ] && [ ! -e "$project/.git" ] || exit 99
    printf 'synthetic controlled edit\\n' > "$project/result"
    exit 42 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
	const result = spawnSync("script", ["-qec", `"${codey}" sandbox --commit HEAD --image ${image}`, "/dev/null"], {
		cwd: linked, env, encoding: "utf8", timeout: 15_000,
	});
	assert.equal(result.status, 42, result.stdout);
	assert.match(result.stdout, /Uncommitted, untracked and ignored files were excluded/);
	const pool = join(home, ".codey", "sandboxes");
	const [task] = readdirSync(pool);
	assert.equal(readFileSync(join(pool, task, "project", "result"), "utf8"), "synthetic controlled edit\n");
	assert.equal(git(["status", "--porcelain"], linked), "");
});
