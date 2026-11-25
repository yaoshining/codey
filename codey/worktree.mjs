// Create a task branch in a separate Git worktree and start a fresh Codey session.
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const usage = "Usage: codey worktree <task> [--base <ref>] [--path <directory>]";
const help = `${usage}

Create branch codey/<task> from a commit and start a new Codey session there.
  --base <ref>         Starting commit, branch or tag (default: HEAD)
  --path <directory>   New checkout path (default: sibling <repo>-<task>)
`;

export async function runWorktree(args, launch) {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		console.log(help.trimEnd());
		return;
	}

	let checkout;
	try {
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

function createCheckout(request, cwd) {
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
	let commit;
	try {
		commit = git(["rev-parse", "--verify", "--end-of-options", `${request.base}^{commit}`], root);
	} catch (error) {
		throw new Error(`Base ${JSON.stringify(request.base)} does not resolve to a commit. ${error.message}`);
	}
	const requested = request.path === undefined
		? join(dirname(root), `${basename(root)}-${request.task}`)
		: resolve(cwd, request.path);
	const path = join(realpathSync(dirname(requested)), basename(requested));
	if (lstatSync(path, { throwIfNoEntry: false })) {
		throw new Error(`Destination already exists: ${JSON.stringify(path)}.`);
	}
	const commonDir = realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root));
	if (includesPath(commonDir, path)) throw new Error("Destination must be outside the shared Git directory.");
	for (const field of git(["worktree", "list", "--porcelain", "-z"], root).split("\0")) {
		if (!field.startsWith("worktree ")) continue;
		const listed = field.slice("worktree ".length);
		const existing = lstatSync(listed, { throwIfNoEntry: false }) ? realpathSync(listed) : listed;
		if (includesPath(existing, path)) {
			throw new Error(`Destination must be outside existing worktree ${JSON.stringify(existing)}.`);
		}
	}

	const branch = `codey/${request.task}`;
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
		const newRoot = realpathSync(git(["rev-parse", "--show-toplevel"], path));
		const head = git(["symbolic-ref", "HEAD"], path);
		if (newRoot !== path || head !== `refs/heads/${branch}`) {
			throw new Error("Git did not select the new checkout and task branch.");
		}
	} catch (error) {
		throw new Error(`Could not verify the new worktree. ${error.message}\nWorktree kept at ${JSON.stringify(path)}.`);
	}
	return { branch, path };
}

function includesPath(directory, path) {
	const child = relative(directory, path);
	return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}
