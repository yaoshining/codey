// Read exact Git blobs into a task directory without checking out on the host.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const digest = "[a-f0-9]{40}(?:[a-f0-9]{24})?";
const treeEntry = new RegExp(`^(100644|100755|120000) blob (${digest})\\t([\\s\\S]+)$`);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const maxFiles = 10_000;
const maxBytes = 128 * 1024 * 1024;

function git(cwd, args, options = {}) {
	const result = spawnSync("git", args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			LANG: "C",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_NO_LAZY_FETCH: "1",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ALLOW_PROTOCOL: "",
		},
		maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
		input: options.input,
		timeout: 30_000,
	});
	if (result.error || result.status !== 0) {
		throw new Error(result.stderr?.toString().trim() || result.error?.message || "Git could not read the commit.");
	}
	return result.stdout;
}

export function prepareSnapshot(cwd, ref) {
	const root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).toString().replace(/\n$/, ""));
	const commit = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).toString().trim();
	const home = realpathSync(homedir());
	const pool = join(home, ".codey", "sandboxes");
	if (/[",\r\n]/.test(pool)) throw new Error("The sandbox storage path cannot contain commas, quotes or line breaks.");

	const common = realpathSync(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().replace(/\n$/, ""));
	const worktrees = decoder.decode(git(root, ["worktree", "list", "--porcelain", "-z"]))
		.split("\0\0")
		.filter((record) => record.startsWith("worktree "))
		.map((record) => {
			const path = record.split("\0", 1)[0].slice(9);
			try {
				return realpathSync(path);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
				return path;
			}
		});
	for (const path of [root, common, ...worktrees]) {
		if (within(path, pool)) {
			throw new Error("Sandbox storage must be outside the source repository's checkouts and Git directory.");
		}
	}

	const entries = decoder.decode(git(root, ["ls-tree", "-rz", "--full-tree", commit])).split("\0");
	entries.pop(); // Git terminates each record with NUL.
	if (entries.length > maxFiles) throw new Error(`The snapshot exceeds the limit of ${maxFiles} files.`);
	const files = [];
	for (const entry of entries) {
		const match = treeEntry.exec(entry);
		if (!match) throw new Error("The snapshot only supports regular Git files and internal symlinks. Submodules are unsupported.");
		const [, mode, oid, path] = match;
		if (path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
			throw new Error(`Unsafe Git path in snapshot: ${JSON.stringify(path)}.`);
		}
		files.push({ mode, oid, path });
	}
	return { root, commit, pool, files };
}

export function createSnapshot({ root, pool, files }) {
	const blobs = git(root, ["cat-file", "--batch"], {
		input: files.map(({ oid }) => `${oid}\n`).join(""),
		maxBuffer: maxBytes + maxFiles * 100,
	});
	for (const dir of [dirname(pool), pool]) {
		if (!lstatSync(dir, { throwIfNoEntry: false })) mkdirSync(dir, { mode: 0o700, recursive: true });
		if (!lstatSync(dir).isDirectory()) throw new Error(`Sandbox storage must be a real directory: ${JSON.stringify(dir)}.`);
	}
	const project = join(mkdtempSync(join(pool, "task-")), "project");
	mkdirSync(project, { mode: 0o700 });
	try {
		let offset = 0;
		let total = 0;
		const links = [];
		for (const { path, oid, mode } of files) {
			const newline = blobs.indexOf(10, offset);
			const prefix = `${oid} blob `;
			const header = blobs.toString("ascii", offset, newline);
			if (newline < 0 || !header.startsWith(prefix) || !/^\d+$/.test(header.slice(prefix.length))) {
				throw new Error("Git returned a missing or unexpected object.");
			}
			const size = Number(header.slice(prefix.length));
			total += size;
			if (total > maxBytes) throw new Error("The snapshot exceeds the limit of 128 MiB.");
			const end = newline + 1 + size;
			if (blobs[end] !== 10) throw new Error("Git returned an incomplete object.");
			const destination = join(project, path);
			mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
			const contents = blobs.subarray(newline + 1, end);
			if (mode === "120000") {
				const target = decoder.decode(contents);
				if (!target || isAbsolute(target) || target.includes("\0")) {
					throw new Error(`Unsupported symlink target at ${JSON.stringify(path)}.`);
				}
				links.push({ destination, target });
			} else {
				writeFileSync(destination, contents, { flag: "wx", mode: mode === "100755" ? 0o700 : 0o600 });
			}
			offset = end + 1;
		}
		if (offset !== blobs.length) throw new Error("Git returned unexpected snapshot data.");
		// Only direct links to paths already materialized are supported. Check them
		// all before creating any link, so writes and validation cannot follow one.
		for (const { destination, target } of links) {
			const parent = dirname(destination);
			const label = JSON.stringify(relative(project, destination));
			let depth = relative(project, parent).split(sep).filter(Boolean).length;
			for (const part of target.split(sep)) {
				if (part === "..") depth--;
				else if (part && part !== ".") depth++;
				if (depth < 0) break;
			}
			if (depth < 0 || !within(project, resolve(parent, target))) {
				throw new Error(`A symlink points outside the snapshot: ${label}.`);
			}
			try {
				realpathSync.native(`${parent}${sep}${target}`);
			} catch {
				throw new Error(`A symlink target is missing or links through another symlink: ${label}.`);
			}
		}
		for (const { destination, target } of links) symlinkSync(target, destination);
		return project;
	} catch (error) {
		throw new Error(`Snapshot incomplete at ${project}. ${error.message}`);
	}
}

function within(directory, path) {
	const rel = relative(directory, path);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
