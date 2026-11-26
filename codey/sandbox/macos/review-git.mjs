// Collect bounded Git patches inside the review-only Seatbelt worker.
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";

const limit = 64 * 1024;
const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const protectedPart = /^(?:\.git(?:-credentials)?|\.env(?:\..*|rc)?|\.ssh|\.aws|\.gnupg|\.codey|\.pi|\.kube|\.docker|\.netrc|\.npmrc|.*\.(?:pem|key|p12)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|auth\.json|credentials(?:\.json)?)$/i;
const privateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const oid = /^[0-9a-f]{40}$/;

function boundedFile(root, path, max, { optional = false, hardLinks = false } = {}) {
	const parts = path.split("/");
	let file = root;
	for (const part of parts.slice(0, -1)) {
		file = join(file, part);
		const stat = lstatSync(file, { throwIfNoEntry: false });
		if (!stat && optional) return;
		if (!stat?.isDirectory()) throw new Error("Review does not follow symlinks or non-directory paths.");
	}
	file = join(file, parts.at(-1));
	const stat = lstatSync(file, { throwIfNoEntry: false });
	if (!stat && optional) return;
	if (!stat?.isFile() || (!hardLinks && stat.nlink !== 1)) throw new Error("Review accepts only regular files without links.");
	if (stat.size > max) throw new Error("A file exceeds the review size limit.");
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd);
		if (stat.dev !== opened.dev || stat.ino !== opened.ino || (!hardLinks && opened.nlink !== 1)) {
			throw new Error("A file changed during review. Try again.");
		}
		const buffer = Buffer.alloc(opened.size > max ? 0 : opened.size + 1);
		if (!buffer.length || readSync(fd, buffer) !== opened.size) throw new Error("A file changed during review. Try again.");
		return buffer.subarray(0, opened.size);
	} finally {
		closeSync(fd);
	}
}

function textBlob(buffer) {
	if (!buffer) return;
	const text = decode.decode(buffer);
	if (text.includes("\0")) throw new Error("Review supports UTF-8 text changes only.");
	if (privateKey.test(text)) throw new Error("Review refused file content that contains private key material.");
	return text;
}

function rawChanges(raw, kind) {
	const fields = raw.split("\0");
	fields.pop();
	const changes = [];
	for (let i = 0; i < fields.length; i += 2) {
		const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [AMDT]$/.exec(fields[i]);
		if (!match || !fields[i + 1]) throw new Error("Review does not support unmerged or special Git entries.");
		const [, beforeMode, afterMode, before, after] = match;
		if (![beforeMode, afterMode].every((mode) => /^(?:000000|100644|100755)$/.test(mode))) {
			throw new Error("Review does not follow symlinks or review submodule changes.");
		}
		changes.push({ kind, path: fields[i + 1], beforeMode, afterMode, before, after });
	}
	return changes;
}

function validatePaths(changes) {
	for (const { path } of changes) {
		const parts = path.split("/");
		if (/[\p{Cc}\p{Cf}]/u.test(path) || parts.some((part) => !part || part === "." || part === ".." || protectedPart.test(part))) {
			throw new Error("Review refused a protected or unsupported file path.");
		}
	}
}

export function collectSandboxReview(workspace, git, tempRoot) {
	const metadata = join(workspace, ".git");
	if (!lstatSync(metadata, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error("Review requires a workspace rooted at a local Git checkout with its own .git directory. Linked worktrees are unavailable.");
	}
	if (!lstatSync(join(metadata, "objects"), { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error("Review requires a local Git object database.");
	}
	const objectInfo = lstatSync(join(metadata, "objects", "info"), { throwIfNoEntry: false });
	if ((objectInfo && !objectInfo.isDirectory()) || ["alternates", "http-alternates"].some((file) =>
		lstatSync(join(metadata, "objects", "info", file), { throwIfNoEntry: false }))) {
		throw new Error("Review does not read alternate Git object databases.");
	}
	const temp = mkdtempSync(join(tempRoot, "review-"));
	const shadow = join(temp, "git");
	try {
		mkdirSync(join(shadow, "refs", "heads"), { recursive: true });
		mkdirSync(join(shadow, "objects"));
		const head = decode.decode(boundedFile(metadata, "HEAD", 4096)).trimEnd();
		const branch = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
		if (!oid.test(head) && (!branch || branch.split("/").some((part) => !part || part.startsWith(".")))) {
			throw new Error("Review requires a standard local SHA-1 Git checkout.");
		}
		writeFileSync(join(shadow, "HEAD"), `${head}\n`);
		if (branch) {
			const loose = boundedFile(metadata, branch, 4096, { optional: true, hardLinks: true });
			const packed = loose ? undefined : boundedFile(metadata, "packed-refs", 1024 * 1024, { optional: true, hardLinks: true });
			const commit = loose ? decode.decode(loose).trimEnd() : packed && decode.decode(packed).split("\n")
				.find((line) => line.endsWith(` ${branch}`))?.split(" ")[0];
			if (commit !== undefined) {
				if (!oid.test(commit)) throw new Error("Review could not resolve a local SHA-1 HEAD.");
				const ref = join(shadow, branch);
				mkdirSync(dirname(ref), { recursive: true });
				writeFileSync(ref, `${commit}\n`);
			}
		}
		const exclude = boundedFile(metadata, "info/exclude", limit, { optional: true });
		if (exclude) {
			mkdirSync(join(shadow, "info"));
			writeFileSync(join(shadow, "info/exclude"), exclude);
		}
		const env = {
			HOME: process.env.HOME, TMPDIR: temp, PATH: "/usr/bin:/bin", LANG: "C",
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
			GIT_INDEX_FILE: join(metadata, "index"), GIT_OBJECT_DIRECTORY: join(metadata, "objects"), GIT_ATTR_NOSYSTEM: "1",
			GIT_NO_REPLACE_OBJECTS: "1",
		};
		const deadline = Date.now() + 15_000;
		function run(args, { diff = false, maxBuffer = limit } = {}) {
			const timeout = deadline - Date.now();
			if (timeout <= 0) throw new Error("Git took too long to collect the review.");
			const result = spawnSync(git, [
				"--no-pager", "--no-optional-locks", `--git-dir=${shadow}`, `--work-tree=${diff ? temp : workspace}`,
				"-c", "core.fsmonitor=false", "-c", "protocol.allow=never", ...args,
			], { cwd: diff ? temp : workspace, env, timeout, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
			if (result.error?.code === "ENOBUFS") throw new Error("The review exceeds its 64 KiB size limit.");
			if (result.error || result.stderr?.length || (result.status !== 0 && !(diff && result.status === 1))) {
				throw new Error("Git could not collect changes within the review boundary.");
			}
			return result.stdout;
		}
		// Check the index itself before Git parses it. Git never reads the user's local config.
		const index = lstatSync(join(metadata, "index"), { throwIfNoEntry: false });
		if (index && (!index.isFile() || index.nlink !== 1 || index.size > 32 * 1024 * 1024)) {
			throw new Error("Review requires a regular Git index no larger than 32 MiB.");
		}
		const raw = ["--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--"];
		const staged = rawChanges(decode.decode(run(["diff", "--cached", "--ignore-submodules=dirty", ...raw])), "Staged changes");
		// Refuse protected staged entries before inspecting the live worktree.
		validatePaths(staged);
		const unstaged = rawChanges(decode.decode(run(["diff-files", "--ignore-submodules=all", ...raw])), "Unstaged changes");
		const untracked = decode.decode(run(["ls-files", "-z", "--others", "--exclude-standard", "--"])).split("\0").filter(Boolean)
			.map((path) => ({ kind: "Untracked file", path, afterMode: "100644" }));
		const changes = [...staged, ...unstaged, ...untracked];
		if (changes.length > 100) throw new Error("More than 100 changes. Review a smaller set of files.");
		validatePaths(unstaged);
		validatePaths(untracked);

		function blob(hash, mode) {
			if (!hash || mode === "000000") return;
			if (Number(run(["cat-file", "-s", hash]).toString()) > limit) throw new Error("A Git blob exceeds the 64 KiB review limit.");
			return textBlob(run(["cat-file", "blob", hash]));
		}
		const patches = [];
		let size = 0;
		for (const { kind, path, before, after, beforeMode, afterMode } of changes) {
			const oldText = blob(before, beforeMode);
			const newText = kind === "Staged changes" ? blob(after, afterMode)
				: afterMode === "000000" ? undefined : textBlob(boundedFile(workspace, path, limit));
			const newMode = afterMode === "000000" ? undefined : afterMode;
			const oldMode = beforeMode === "000000" ? undefined : beforeMode;
			if (oldText === newText && oldMode === newMode) continue;
			const left = oldText === undefined ? "/dev/null" : "before";
			const right = newText === undefined ? "/dev/null" : "after";
			if (oldText !== undefined) writeFileSync(join(temp, left), oldText);
			if (newText !== undefined) writeFileSync(join(temp, right), newText);
			const diff = decode.decode(run(["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", left, right], { diff: true }));
			const hunk = diff.indexOf("\n@@ ");
			const labels = [oldMode ? JSON.stringify(`a/${path}`) : "/dev/null", newMode ? JSON.stringify(`b/${path}`) : "/dev/null"];
			const modeChange = oldMode === newMode ? "" : `\nFile mode: ${oldMode ?? "absent"} -> ${newMode ?? "absent"}`;
			const patch = `--- ${labels[0]}\n+++ ${labels[1]}${modeChange}${hunk < 0 ? "" : diff.slice(hunk)}`;
			size += Buffer.byteLength(patch);
			if (size > limit) throw new Error("The Git patches exceed the 64 KiB review limit.");
			patches.push({ kind, patch });
		}
		return patches;
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}
