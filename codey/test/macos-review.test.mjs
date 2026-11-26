import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectSandboxReview } from "../sandbox/macos/review-git.mjs";

test("review collects staged, unstaged and nonignored untracked text through real Git", (t) => {
	const root = mkdtempSync(join(tmpdir(), "codey-review-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const scratch = join(root, "scratch");
	mkdirSync(repo);
	mkdirSync(scratch);
	const git = (...args) => execFileSync("/usr/bin/git", args, {
		cwd: repo, env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	const put = (path, text) => writeFileSync(join(repo, path), text);
	const collect = () => collectSandboxReview(repo, "/usr/bin/git", scratch);
	git("init", "-qb", "main");
	put("tracked file", "original\n");
	put(".gitignore", "ignored\n");
	git("add", ".");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial");
	assert.deepEqual(collect(), []);
	put("tracked file", "staged\n");
	git("add", "tracked file");
	put("tracked file", "original\n");
	put("new", "untracked\n");
	put("ignored", "ignored canary\n");
	put(".git/info/exclude", "locally-ignored\n");
	put("locally-ignored", "local canary\n");
	// A benign configured diff helper must not run or affect the review.
	git("config", "diff.external", "/usr/bin/false");
	const index = readFileSync(join(repo, ".git/index"));
	const patches = collect();
	assert.deepEqual(patches.map(({ kind }) => kind), ["Staged changes", "Unstaged changes", "Untracked file"]);
	assert.match(patches[0].patch, /"b\/tracked file"[\s\S]*-original\n\+staged/);
	assert.match(patches[1].patch, /-staged\n\+original/);
	assert.match(patches[2].patch, /\+untracked/);
	assert.equal(JSON.stringify(patches).includes("canary"), false);
	assert.deepEqual(readFileSync(join(repo, ".git/index")), index);

	put(".env", "synthetic marker\n");
	git("add", ".env");
	assert.throws(collect, /protected or unsupported/);
	git("rm", "-fq", ".env");
	put("too-big", "x".repeat(65_537));
	assert.throws(collect, /size limit/);
	rmSync(join(repo, "too-big"));
	symlinkSync(join(root, "fake-host-marker"), join(repo, "link"));
	assert.throws(collect, /without links/);
	rmSync(join(repo, "link"));
	put("text", "-----BEGIN PRIVATE KEY-----\nsynthetic marker\n");
	assert.throws(collect, /private key material/);
});
