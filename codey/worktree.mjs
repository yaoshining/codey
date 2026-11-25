// Create a task branch in a separate Git worktree and start a fresh Codey session.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const usage = "Usage: codey worktree <task> [--base <ref>] [--path <directory>]";
const marker = "codey-worktree.json";
const help = `${usage}

Create branch codey/<task> from a commit and start a new Codey session there.
  --base <ref>         Starting commit, branch or tag (default: HEAD)
  --path <directory>   Custom checkout path outside managed storage
  Default destination: ~/.codey/worktrees/<id>/<project>

  codey worktree list           List managed worktrees for this repository
  codey worktree delete <id>    Remove a managed checkout with Git
`;

export async function runWorktree(args, launch) {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		console.log(help.trimEnd());
		return;
	}

	let checkout;
	try {
		if (args[0] === "list" && args.length === 1) {
			for (const entry of listManagedWorktrees(process.cwd())) {
				console.log(`${entry.id}\t${entry.branch}\t${JSON.stringify(entry.path)}${entry.current ? "\t(current)" : ""}`);
			}
			return;
		}
		if (args[0] === "delete" && args.length === 2) {
			const path = deleteManagedWorktree(args[1], process.cwd());
			console.log(`Removed worktree at ${JSON.stringify(path)}.`);
			return;
		}
		if (args[0] === "list" || args[0] === "delete") throw new Error(help.trimEnd());
		const request = parseRequest(args);
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("Run codey worktree in an interactive terminal.");
		}
		checkout = createCheckout(request, process.cwd());
		process.chdir(checkout.path);
	} catch (error) {
		console.error(`Codey worktree: ${error.message}`);
		process.exitCode = 1;
		return;
	}

	console.error(`Codey worktree: created ${checkout.branch} at ${JSON.stringify(checkout.path)}. Starting a new session.`);
	try {
		await launch();
	} catch (error) {
		console.error(`Codey startup failed: ${error.message}\nWorktree kept at ${JSON.stringify(checkout.path)}.`);
		process.exitCode = 1;
	}
}

function parseRequest(args) {
	const [task, ...options] = args;
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(task ?? "")) {
		throw new Error(`Use a task name with letters, digits, hyphens or underscores.\n${usage}`);
	}
	const parsed = {};
	for (let i = 0; i < options.length; i += 2) {
		const flag = options[i];
		const value = options[i + 1];
		if (flag !== "--base" && flag !== "--path") throw new Error(`Unknown option ${JSON.stringify(flag)}.\n${usage}`);
		if (!value || value.startsWith("--") || parsed[flag] !== undefined) {
			throw new Error(`Supply exactly one value for ${flag}.\n${usage}`);
		}
		parsed[flag] = value;
	}
	return { task, base: parsed["--base"] ?? "HEAD", path: parsed["--path"] };
}

function openRepository(cwd) {
	const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
	function git(args, directory = cwd) {
		try {
			return execFileSync("git", args, {
				cwd: directory,
				env: gitEnv,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).replace(/\n$/, "");
		} catch (error) {
			throw new Error(error.stderr?.trim() || error.message);
		}
	}
	const localOverrides = git(["rev-parse", "--local-env-vars"])
		.split("\n")
		.filter((name) => process.env[name] !== undefined);
	if (localOverrides.length) {
		throw new Error(`Unset Git repository overrides before running this command: ${localOverrides.join(", ")}.`);
	}

	const root = realpathSync(git(["rev-parse", "--show-toplevel"]));
	const commonDir = realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root));
	return { root, commonDir, git };
}

function poolPath(create = false) {
	const home = realpathSync(homedir());
	const codey = join(home, ".codey");
	const pool = join(codey, "worktrees");
	for (const dir of [codey, pool]) {
		if (!lstatSync(dir, { throwIfNoEntry: false }) && create) mkdirSync(dir, { recursive: true, mode: 0o700 });
		const stat = lstatSync(dir, { throwIfNoEntry: false });
		if (!stat) return pool;
		if (!stat.isDirectory()) throw new Error(`Managed worktree storage must be a directory: ${JSON.stringify(dir)}.`);
	}
	return pool;
}

function registrations({ git, root }) {
	return git(["worktree", "list", "--porcelain", "-z"], root).split("\0\0").map((record) => {
		const fields = record.split("\0");
		return {
			path: fields[0]?.startsWith("worktree ") ? fields[0].slice(9) : undefined,
			branch: fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18) ?? "(detached)",
		};
	}).filter((entry) => entry.path);
}

function privateGitDir(repo, path) {
	const { git, commonDir } = repo;
	if (realpathSync(git(["rev-parse", "--show-toplevel"], path)) !== path ||
		realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path)) !== commonDir) return;
	const gitDir = realpathSync(git(["rev-parse", "--absolute-git-dir"], path));
	if (dirname(gitDir) === join(commonDir, "worktrees")) return gitDir;
}

export function listManagedWorktrees(cwd) {
	const repo = openRepository(cwd);
	return managedWorktrees(repo, poolPath(), cwd);
}

function managedWorktrees(repo, pool, cwd) {
	const currentCwd = realpathSync(cwd);
	const processCwd = realpathSync(process.cwd());
	const result = [];
	for (const entry of registrations(repo)) {
		const parts = relative(pool, entry.path).split(sep);
		if (parts.length !== 2 || !/^task-[a-zA-Z0-9]{6}$/.test(parts[0])) continue;
		if (!lstatSync(join(pool, parts[0]), { throwIfNoEntry: false })?.isDirectory() ||
			!lstatSync(entry.path, { throwIfNoEntry: false })?.isDirectory()) continue;
		if (realpathSync(entry.path) !== entry.path) continue;
		try {
			const gitDir = privateGitDir(repo, entry.path);
			if (!gitDir) continue;
			const receipt = join(gitDir, marker);
			if (!lstatSync(receipt, { throwIfNoEntry: false })?.isFile()) continue;
			const recorded = JSON.parse(readFileSync(receipt, "utf8"));
			if (recorded.path !== entry.path || recorded.id !== parts[0]) continue;
			result.push({
				...entry,
				id: parts[0],
				current: includesPath(entry.path, currentCwd) || includesPath(entry.path, processCwd),
			});
		} catch {
			// A stale or invalid registration is never a managed deletion target.
		}
	}
	return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function deleteManagedWorktree(id, cwd) {
	const repo = openRepository(cwd);
	const entry = managedWorktrees(repo, poolPath(), cwd).find((candidate) => candidate.id === id);
	if (!entry) throw new Error(`No managed worktree with ID ${JSON.stringify(id)} in this repository.`);
	if (entry.current) throw new Error("Switch to another checkout before deleting the current worktree.");
	// Git's native removal checks tracked and untracked changes but can erase ignored files.
	if (repo.git(["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all", "--ignored=matching"], entry.path)) {
		throw new Error("The worktree contains modified or untracked files, including ignored files. It was kept.");
	}
	repo.git(["worktree", "remove", "--", entry.path], repo.root);
	removeEmptyBucket(dirname(entry.path));
	return entry.path;
}

function removeEmptyBucket(bucket) {
	try {
		rmdirSync(bucket);
	} catch {
		// A partially populated check-out or any other contents stay in place.
	}
}

export function createCheckout(request, cwd) {
	const repo = openRepository(cwd);
	const { git, root } = repo;
	let commit;
	try {
		commit = git(["rev-parse", "--verify", "--end-of-options", `${request.base}^{commit}`], root);
	} catch (error) {
		throw new Error(`Base ${JSON.stringify(request.base)} does not resolve to a commit. ${error.message}`);
	}
	const branch = `codey/${request.task}`;
	if (request.path !== undefined) {
		const requested = resolve(cwd, request.path);
		const path = join(realpathSync(dirname(requested)), basename(requested));
		if (includesPath(poolPath(), path)) throw new Error("Custom checkout paths must be outside managed storage.");
		return addCheckout(repo, path, branch, commit);
	}

	const pool = poolPath();
	const registered = registrations(repo);
	if (includesPath(repo.commonDir, pool) || registered.some(({ path }) => includesPath(path, pool))) {
		throw new Error("Managed worktree storage must be outside all registered worktrees and the shared Git directory.");
	}
	const bucket = mkdtempSync(join(poolPath(true), "task-"));
	const path = join(bucket, basename(registered[0]?.path ?? root));
	try {
		const checkout = addCheckout(repo, path, branch, commit);
		const id = basename(bucket);
		writeFileSync(join(checkout.gitDir, marker), JSON.stringify({ id, path }), { flag: "wx", mode: 0o600 });
		return { ...checkout, id };
	} catch (error) {
		removeEmptyBucket(bucket);
		throw new Error(`Could not create managed worktree at ${JSON.stringify(path)}. ${error.message}`);
	}
}

function addCheckout(repo, path, branch, commit) {
	const { root, commonDir, git } = repo;
	if (lstatSync(path, { throwIfNoEntry: false })) throw new Error(`Destination already exists: ${JSON.stringify(path)}.`);
	if (includesPath(commonDir, path)) throw new Error("Destination must be outside the shared Git directory.");
	for (const entry of registrations(repo)) {
		const existing = lstatSync(entry.path, { throwIfNoEntry: false }) ? realpathSync(entry.path) : entry.path;
		if (includesPath(existing, path)) throw new Error(`Destination must be outside existing worktree ${JSON.stringify(existing)}.`);
	}
	try {
		// Checkout hooks may make changes in the source project before Pi's project trust check.
		git(
			["-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", "worktree", "add", "--quiet", "-b", branch, "--", path, commit],
			root,
		);
	} catch (error) {
		throw new Error(
			`Git could not create ${branch} at ${JSON.stringify(path)}. ${error.message}\nCheck git worktree list and git branch for any partial setup.`,
		);
	}
	try {
		const gitDir = privateGitDir(repo, path);
		const head = git(["symbolic-ref", "HEAD"], path);
		if (!gitDir || head !== `refs/heads/${branch}`) {
			throw new Error("Git did not select the new checkout and task branch.");
		}
		return { branch, path, gitDir };
	} catch (error) {
		throw new Error(`Could not verify the new worktree. ${error.message}\nWorktree kept at ${JSON.stringify(path)}.`);
	}
}

function includesPath(directory, path) {
	const child = relative(directory, path);
	return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}
