// Management Git is isolated from both the model worker and host Git settings.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { appleGit, contains, managedProfile, systemDyldCache } from "./seatbelt.mjs";

const rules = readFileSync(new URL("./worktree.sbpl", import.meta.url), "utf8");
const receipt = "codey-worktree.json";
const bucketPattern = /^task-[A-Za-z0-9]{6}$/;
const hashPattern = /^[0-9a-f]{40}$/;
const safeText = (text) => !/[\p{Cc}\p{Cf}]/u.test(text);

function directory(path, create = false) {
	if (create) {
		try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
	}
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return false;
	if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022) || realpathSync(path) !== path) {
		throw new Error("Worktree management requires canonical, user-owned directories protected from other writers.");
	}
	return true;
}

function textFile(path, max = 4096, optional = false) {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat && optional) return;
	if (!stat?.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022) || stat.nlink !== 1 || stat.size > max) {
		throw new Error("Invalid or unsupported Git metadata file.");
	}
	return readFileSync(path, "utf8");
}

// Root must be the workspace the user originally approved. Linked worktrees
// can be used after a switch without letting an arbitrary .git pointer pick the repository.
export function sandboxWorktrees(root, home) {
	const common = join(root, ".git");
	const codey = join(home, ".codey");
	const pool = join(codey, "worktrees");
	if (!safeText(root) || !safeText(pool) || !directory(root) || !directory(common) || contains(root, pool) || contains(pool, root)) {
		throw new Error("Start worktree management from the root of the source checkout with its own .git directory.");
	}
	const git = appleGit();
	const dyld = systemDyldCache();

	function run(scratch, args, { target = scratch, metadata = common, mutation } = {}) {
		const profile = join(scratch, "git.sbpl");
		writeFileSync(profile, `${managedProfile()}\n${rules}${mutation ? "" : '\n(deny file-write* (subpath (param "WORKSPACE")))\n'}`, { mode: 0o600 });
		const disabled = join(scratch, "disabled");
		const params = {
			WORKSPACE: target, SCRATCH: scratch, INSTALL: disabled, NODE: disabled, TOOLCHAIN: disabled, TOOLCHAIN_LINKS: disabled,
			DYLD_CACHE: dyld, GIT: git, GIT_LIB: join(dirname(dirname(git)), "lib"), COMMON: common,
			REGISTRATION_WRITE: mutation === "create" ? join(common, "worktrees") : mutation?.gitDir ?? disabled,
			REF_WRITE: mutation === "create" ? join(common, "refs/heads/codey") : disabled,
			REFLOG_WRITE: mutation === "create" ? join(common, "logs/refs/heads/codey") : disabled,
			PACKED_LOCK: mutation === "create" ? join(common, "packed-refs.lock") : disabled,
		};
		const result = spawnSync("/usr/bin/sandbox-exec", ["-f", profile,
				...Object.entries(params).flatMap(([key, value]) => ["-D", `${key}=${value}`]),
				git, "--no-pager", "--no-optional-locks", `--git-dir=${metadata}`, `--work-tree=${target}`,
				"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never",
				"-c", "submodule.recurse=false", "-c", "core.autocrlf=false", ...args,
			], {
				cwd: "/", env: { PATH: `${dirname(git)}:/usr/bin:/bin`, GIT_EXEC_PATH: dirname(git), HOME: scratch, TMPDIR: scratch, LANG: "C", GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
					GIT_NO_REPLACE_OBJECTS: "1", GIT_AUTHOR_NAME: "Codey sandbox", GIT_AUTHOR_EMAIL: "codey@example.invalid",
					GIT_COMMITTER_NAME: "Codey sandbox", GIT_COMMITTER_EMAIL: "codey@example.invalid" },
				encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"],
			});
		if (result.error || result.status !== 0 || result.stderr?.trim()) {
			throw new Error(`Git could not complete worktree management within its sandbox. ${result.stderr?.trim().slice(0, 1600) ?? ""}`.trimEnd());
		}
		return result.stdout;
	}

	function checkConfig(scratch) {
		directory(common);
		textFile(join(common, "config"), 64 * 1024);
		directory(join(common, "objects", "info"));
		directory(join(common, "worktrees"));
		if (!directory(join(common, "objects")) || ["alternates", "http-alternates"].some((name) =>
			lstatSync(join(common, "objects", "info", name), { throwIfNoEntry: false })) ||
			["config.worktree", "commondir"].some((name) => lstatSync(join(common, name), { throwIfNoEntry: false }))) {
			throw new Error("Unsupported worktree configuration or alternate Git object database.");
		}
		const fields = run(scratch, ["config", "--no-includes", "--null", "--file", join(common, "config"), "--list"]).split("\0").filter(Boolean);
		for (const field of fields) {
			const index = field.indexOf("\n");
			const key = field.slice(0, index);
			const value = field.slice(index + 1);
			if (index < 0 || !safeText(value) || !(
				(key === "core.repositoryformatversion" && value === "0") ||
				(key === "core.bare" && value === "false") ||
				(/^core\.(?:filemode|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/.test(key) && /^(?:true|false)$/.test(value)) ||
				/^(?:user\.(?:name|email)|remote\.[^.]+\.(?:url|fetch)|branch\.[^.]+\.(?:remote|merge))$/.test(key)
			)) throw new Error("The repository's Git configuration is outside the supported worktree settings.");
		}
	}

	function withGit(operation) {
		const scratch = mkdtempSync("/private/tmp/codey-worktree-git-");
		try {
			checkConfig(scratch);
			return operation(scratch);
		} finally { rmSync(scratch, { recursive: true, force: true }); }
	}

	function registrations(scratch) {
		return run(scratch, ["worktree", "list", "--porcelain", "-z"]).split("\0\0").filter(Boolean).map((record) => {
			const [path, ...fields] = record.split("\0");
			return { path: path.slice(9), branch: fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18) ?? "(detached)" };
		});
	}

	function lookup(path) {
		const bucket = dirname(path);
		const id = basename(bucket);
		if (dirname(bucket) !== pool || !bucketPattern.test(id) || !safeText(path) ||
			!directory(codey) || !directory(pool) || !directory(bucket) || !directory(path)) return;
		const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(textFile(join(path, ".git")) ?? "")?.[1];
		const registers = join(common, "worktrees");
		if (!pointer || dirname(pointer) !== registers || !directory(registers) || !directory(pointer)) return;
		if (textFile(join(pointer, "commondir")).trimEnd() !== "../.." ||
			textFile(join(pointer, "gitdir")).trimEnd() !== join(path, ".git") ||
			lstatSync(join(pointer, "config.worktree"), { throwIfNoEntry: false })) return;
		return { id, path, gitDir: pointer };
	}

	function list(scratch, current) {
		const entries = [];
		for (const { path, branch } of registrations(scratch)) {
			try {
				const entry = lookup(path);
				if (!entry) continue;
				const marked = JSON.parse(textFile(join(entry.gitDir, receipt)));
				if (marked.id === entry.id && marked.path === path && safeText(branch)) entries.push({
					...entry, branch, current: contains(path, current) || contains(path, realpathSync(process.cwd())),
				});
			} catch { /* A stale or malformed worktree is not a management target. */ }
		}
		return entries.sort((a, b) => a.id.localeCompare(b.id));
	}

	return {
		list: (cwd) => withGit((scratch) => list(scratch, cwd)),
		create(cwd) {
			return withGit((scratch) => {
				const source = cwd === root ? { gitDir: common } : list(scratch, cwd).find(({ path }) => path === cwd);
				if (!source) throw new Error("The current checkout is no longer registered for this repository.");
				const commit = run(scratch, ["rev-parse", "--verify", "HEAD^{commit}"], { metadata: source.gitDir }).trimEnd();
				if (!hashPattern.test(commit)) throw new Error("Worktree creation needs a local SHA-1 HEAD commit.");
				if (registrations(scratch).some(({ path }) => contains(path, pool))) {
					throw new Error("Managed storage must be outside every registered checkout.");
				}
				directory(codey, true);
				directory(pool, true);
				const bucket = mkdtempSync(join(pool, "task-"));
				const target = join(bucket, basename(root));
				const branch = `codey/task-${randomBytes(6).toString("hex")}`;
				try {
					run(scratch, ["worktree", "add", "--quiet", "--no-track", "-b", branch, "--", target, commit], { target, mutation: "create" });
					const created = lookup(target);
					if (!created || !registrations(scratch).some((entry) => entry.path === target && entry.branch === branch)) {
						throw new Error("Could not verify the new Git registration.");
					}
					writeFileSync(join(created.gitDir, receipt), JSON.stringify({ id: created.id, path: target }), { flag: "wx", mode: 0o600 });
					return target;
				} catch (error) {
					try { rmdirSync(bucket); } catch { /* Keep any partial checkout for inspection. */ }
					throw new Error(`${error.message}\nCheck for any partial checkout at ${target}.`);
				}
			});
		},
		remove(id, cwd) {
			return withGit((scratch) => {
				const entry = list(scratch, cwd).find((item) => item.id === id);
				if (!entry || entry.current) throw new Error("Choose an existing worktree outside the current directory.");
				checkRemovablePaths(entry.path);
				const options = { target: entry.path, metadata: entry.gitDir };
				if (run(scratch, ["ls-files", "-v", "-z"], options).split("\0").some((file) => file && !file.startsWith("H "))) {
					throw new Error("The worktree contains index flags that can hide changes. It was kept.");
				}
				if (run(scratch, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"], options)) {
					throw new Error("The worktree contains modified, untracked, or ignored files. It was kept.");
				}
				run(scratch, ["worktree", "remove", "--", entry.path], { target: entry.path, mutation: entry });
				try { rmdirSync(dirname(entry.path)); } catch { /* Leave any other contents. */ }
				return entry.path;
			});
		},
	};
}

function checkRemovablePaths(root) {
	const protectedName = /^(?:\.git(?:-credentials)?|\.env(?:\..*|rc)?|\.ssh|\.aws|\.gnupg|\.codey|\.pi|\.kube|\.docker|\.netrc|\.npmrc|.*\.(?:pem|key|p12)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|auth\.json|credentials(?:\.json)?)$/i;
	const pending = [root];
	let count = 0;
	while (pending.length) {
		const parent = pending.pop();
		if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) {
			throw new Error("A worktree directory changed during verification. It was kept.");
		}
		for (const entry of readdirSync(parent, { withFileTypes: true })) {
			if (++count > 100_000) throw new Error("The worktree is too large to verify before deletion. It was kept.");
			if (parent === root && entry.name === ".git") continue;
			if (!safeText(entry.name) || protectedName.test(entry.name)) {
				throw new Error("The worktree contains a protected or unsupported path. It was kept.");
			}
			if (entry.isDirectory()) pending.push(join(parent, entry.name));
		}
	}
}
