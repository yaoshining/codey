// Exercise worktree provisioning against disposable Git repositories.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const command = `
	import { runWorktree } from ${JSON.stringify(new URL("../worktree.mjs", import.meta.url).href)};
	Object.defineProperty(process.stdin, "isTTY", { value: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true });
	await runWorktree(process.argv.slice(1), () => {
		if (process.argv[1] === "startup-failure") throw new Error("fixture startup failure");
		console.log(process.cwd());
	});
`;

function fixture(t) {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "codey-worktree-")));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const cwd = join(parent, "project ' #?");
	mkdirSync(cwd);
	const env = {
		PATH: process.env.PATH,
		HOME: parent,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_OPTIONAL_LOCKS: "0",
	};
	const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trimEnd();
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "maintenance.auto", "false");
	writeFileSync(join(cwd, "tracked"), "base\n");
	git("add", "tracked");
	git("commit", "-qm", "baseline");
	const runAt = (directory, ...args) => {
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", command, "--", ...args], {
			cwd: directory,
			env,
			encoding: "utf8",
			timeout: 20_000,
		});
		assert.ifError(result.error);
		return result;
	};
	return { parent, cwd, git, runAt, run: (...args) => runAt(cwd, ...args) };
}

test("creates a branch at the requested base and launches from the new root without changing the source", (t) => {
	const { parent, cwd, git, run } = fixture(t);
	git("branch", "baseline");
	writeFileSync(join(cwd, "head-only"), "new commit\n");
	git("add", "head-only");
	git("commit", "-qm", "advance main");
	writeFileSync(join(cwd, "tracked"), "staged\n");
	git("add", "tracked");
	writeFileSync(join(cwd, "tracked"), "unstaged\n");
	writeFileSync(join(cwd, "untracked"), "untracked\n");
	writeFileSync(join(cwd, ".git/hooks/post-checkout"), "#!/bin/sh\necho hook ran > hook-ran\n", { mode: 0o755 });

	const status = git("status", "--porcelain");
	const index = readFileSync(join(cwd, ".git/index"));
	const destination = join(parent, "task ' #? checkout");
	const result = run("task-one", "--path", destination, "--base", "baseline");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), destination);
	assert.equal(git("-C", destination, "branch", "--show-current"), "codey/task-one");
	assert.equal(git("-C", destination, "rev-parse", "HEAD"), git("rev-parse", "baseline"));
	assert.equal(readFileSync(join(destination, "tracked"), "utf8"), "base\n");
	for (const path of ["head-only", "untracked", "hook-ran"]) assert.equal(existsSync(join(destination, path)), false);
	assert.equal(git("branch", "--show-current"), "main");
	assert.equal(git("status", "--porcelain"), status);
	assert.deepEqual(readFileSync(join(cwd, ".git/index")), index);
});

test("rejects invalid bases, directory collisions and existing branches without removing any checkout", (t) => {
	const { parent, cwd, git, run } = fixture(t);
	const first = run("first");
	assert.equal(first.status, 0, first.stderr);
	const checkout = first.stdout.trim();
	writeFileSync(join(checkout, "keep-me"), "dirty checkout\n");
	git("branch", "codey/already");
	const initial = git("worktree", "list", "--porcelain");
	const branches = git("branch", "--format=%(refname)");
	const external = join(parent, "outside");
	const inside = join(cwd, "inside");
	symlinkSync(cwd, join(parent, "symlink"), "dir");

	for (const [args, expected] of [
		[["bad", "--base", "missing"], /does not resolve to a commit/],
		[["first"], /already exists/],
		[["already", "--path", external], /already exists/],
		[["nested", "--path", inside], /outside existing worktree/],
		[["nested", "--path", join(parent, "symlink", "inside")], /outside existing worktree/],
		[["other", "--path", checkout], /outside managed storage/],
		[["../escape"], /Use a task name/],
		[["other", "--session", "old"], /Unknown option/],
	]) {
		const result = run(...args);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, expected);
		assert.equal(result.stdout, "");
	}

	assert.equal(git("worktree", "list", "--porcelain"), initial);
	assert.equal(git("branch", "--format=%(refname)"), branches);
	assert.equal(readFileSync(join(checkout, "keep-me"), "utf8"), "dirty checkout\n");
	assert.equal(existsSync(external), false);
	assert.equal(existsSync(inside), false);
});

test("keeps the task branch and checkout when the Codey launch fails", (t) => {
	const { parent, cwd, git, run } = fixture(t);
	const destination = join(parent, "kept checkout");
	const result = run("startup-failure", "--path", destination);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /fixture startup failure/);
	assert.match(result.stderr, /Worktree kept/);
	assert.equal(git("-C", destination, "branch", "--show-current"), "codey/startup-failure");
	assert.equal(git("-C", destination, "status", "--porcelain"), "");
	assert.equal(git("-C", cwd, "branch", "--show-current"), "main");
});


test("lists and safely deletes managed checkouts by Git identity", (t) => {
	const { parent, cwd, git, run, runAt } = fixture(t);
	const first = run("managed-a");
	const second = run("managed-b");
	assert.equal(first.status, 0, first.stderr);
	assert.equal(second.status, 0, second.stderr);
	const path = first.stdout.trim();
	const other = second.stdout.trim();
	assert.notEqual(path, other);
	const rows = run("list").stdout.trim().split("\n");
	assert.equal(rows.length, 2);
	const id = rows.find((row) => row.includes("codey/managed-a")).split("\t")[0];
	const bucket = join(parent, ".codey", "worktrees", id);
	assert.equal(path, join(bucket, "project ' #?"));
	const child = join(path, "child");
	const alias = join(parent, "alias");
	mkdirSync(child);
	symlinkSync(child, alias, "dir");
	for (const here of [path, child, alias]) {
		const result = runAt(here, "delete", id);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /current worktree/);
	}
	assert.match(runAt(alias, "list").stdout, /codey\/managed-a.*\(current\)/);
	writeFileSync(join(path, "dirty"), "preserve");
	const dirty = run("delete", id);
	assert.equal(dirty.status, 1);
	assert.match(dirty.stderr, /modified or untracked/);
	assert.equal(readFileSync(join(path, "dirty"), "utf8"), "preserve");
	rmSync(join(path, "dirty"));
	const ignores = join(parent, "ignore-rules");
	writeFileSync(ignores, "ignored-output\n");
	git("config", "core.excludesFile", ignores);
	writeFileSync(join(path, "ignored-output"), "preserve ignored file");
	assert.equal(git("-C", path, "status", "--porcelain"), "");
	const ignored = run("delete", id);
	assert.equal(ignored.status, 1);
	assert.match(ignored.stderr, /including ignored files/);
	assert.equal(readFileSync(join(path, "ignored-output"), "utf8"), "preserve ignored file");
	rmSync(join(path, "ignored-output"));
	rmdirSync(child);
	const removed = run("delete", id);
	assert.equal(removed.status, 0, removed.stderr);
	assert.equal(existsSync(bucket), false);
	assert.equal(git("rev-parse", "codey/managed-a"), git("rev-parse", "main"));
	assert.equal(existsSync(other), true);
	assert.equal(existsSync(cwd), true);

	const custom = join(parent, "custom");
	assert.equal(run("custom", "--path", custom).status, 0);
	assert.doesNotMatch(run("list").stdout, /codey\/custom/);
	assert.equal(run("delete", custom).status, 1);
	assert.equal(existsSync(custom), true);
	const fromCustom = runAt(custom, "from-custom");
	assert.equal(fromCustom.status, 0, fromCustom.stderr);
	assert.equal(fromCustom.stdout.trim().split("/").at(-1), "project ' #?");

	const unmarked = join(parent, ".codey", "worktrees", "task-ABC123", "unmarked");
	git("worktree", "add", "-qb", "codey/unmarked", unmarked);
	assert.doesNotMatch(run("list").stdout, /codey\/unmarked/);
	assert.equal(run("delete", "task-ABC123").status, 1);
	assert.equal(existsSync(unmarked), true);
});
