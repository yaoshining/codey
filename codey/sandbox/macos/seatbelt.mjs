// Run bounded tools under the fixed macOS backend, using pipes and an allowlisted environment.
import { execFileSync, spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const install = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
const backend = "/usr/bin/sandbox-exec";
const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const profile = fileURLToPath(new URL("./profile.sbpl", import.meta.url));
const reviewRules = fileURLToPath(new URL("./review.sbpl", import.meta.url));
const resolver = pathToFileURL(join(install, "packages/coding-agent/src/experimental/source-resolver.ts")).href;
const outputLimit = 1024 * 1024;

export function systemDyldCache() {
	for (const prefix of ["/System/Cryptexes/OS", "/System/Volumes/Preboot/Cryptexes/OS", "/private/preboot/Cryptexes/OS"]) {
		try {
			const path = realpathSync(join(prefix, "System/Library/dyld"));
			if (path.startsWith("/System/Volumes/Preboot/") || path.startsWith("/private/preboot/")) return path;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	return "/System/Library/dyld";
}

export function contains(root, path) {
	const child = relative(root, path);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith("../"));
}

export function appleGit() {
	const path = realpathSync(execFileSync("/usr/bin/xcrun", ["--find", "git"], {
		cwd: "/", env: { HOME: "/var/empty", PATH: "/usr/bin:/bin" }, encoding: "utf8",
		timeout: 5000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"],
	}).trim());
	if (!/^\/(?:Applications\/[^/]+\.app\/Contents\/Developer\/(?:Toolchains\/[^/]+\/)?|Library\/Developer\/CommandLineTools\/)usr\/bin\/git$/.test(path)) {
		throw new Error("This feature needs Git from Xcode or the Apple Command Line Tools.");
	}
	return path;
}

// The outer managed path itself contains .codey. Keep all other protected names
// and deny new .codey directories even inside the selected managed checkout.
export function managedProfile() {
	return readFileSync(profile, "utf8").replace("|[.][cC][oO][dD][eE][yY]", "") + `
(deny file-read-data file-write*
  (require-all
    (regex #"/[.][cC][oO][dD][eE][yY](/|$)")
    (require-not (subpath (param "WORKSPACE")))))
(deny file-read* file-write*
  (regex #"/[.][cC][oO][dD][eE][yY]/.*/[.][cC][oO][dD][eE][yY](/|$)"))
`;
}

export async function openSeatbelt(workspace, hostHome) {
	if (!lstatSync(backend, { throwIfNoEntry: false })?.isFile()) {
		throw new Error("The macOS Seatbelt launcher /usr/bin/sandbox-exec is unavailable.");
	}
	const node = realpathSync(process.execPath);
	const brew = ["/opt/homebrew", "/usr/local"].find((path) => node.startsWith(`${path}/Cellar/node`));
	for (const path of [hostHome, "/private/tmp", install, node, "/System", "/usr", "/bin", "/opt/homebrew"]) {
		if (contains(workspace, path)) throw new Error("Choose a workspace that excludes Home, the runtime and system directories.");
	}
	if ([install, "/System", "/usr", "/bin", "/opt/homebrew"].some((path) => contains(path, workspace))) {
		throw new Error("Choose a project outside the runtime and system directories.");
	}
	const gitFile = join(workspace, ".git");
	const gitStat = lstatSync(gitFile, { throwIfNoEntry: false });
	if (gitStat?.isSymbolicLink()) throw new Error("A symlinked .git directory is unsupported.");
	if (gitStat?.isFile()) {
		if (gitStat.size > 4096) throw new Error("The linked worktree's .git pointer is too large.");
		const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(gitFile, "utf8"));
		const privateDir = pointer && realpathSync(resolve(workspace, pointer[1]));
		if (!privateDir || contains(workspace, privateDir)) {
			throw new Error("The linked worktree must keep its Git metadata outside the writable workspace.");
		}
		const commonFile = join(privateDir, "commondir");
		const commonStat = lstatSync(commonFile, { throwIfNoEntry: false });
		if (commonStat) {
			if (!commonStat.isFile() || commonStat.size > 4096) throw new Error("Unsupported Git common directory pointer.");
			const common = readFileSync(commonFile, "utf8").replace(/\r?\n$/, "");
			if (!common || /[\r\n]/.test(common) || contains(workspace, realpathSync(resolve(privateDir, common)))) {
				throw new Error("The linked worktree's common Git directory must be outside the writable workspace.");
			}
		}
	}

	const dyldCache = systemDyldCache();
	const hostDir = mkdtempSync("/private/tmp/codey-sandbox-host-");
	const scratch = mkdtempSync("/private/tmp/codey-sandbox-worker-");
	const close = () => {
		// The worker can populate its directory with links. rmSync removes those links themselves.
		rmSync(scratch, { recursive: true, force: true });
		rmSync(hostDir, { recursive: true, force: true });
	};
	const params = {
		WORKSPACE: workspace, SCRATCH: scratch, INSTALL: install, NODE: node,
		TOOLCHAIN: brew ? `${brew}/Cellar` : "/dev/null",
		TOOLCHAIN_LINKS: brew ? `${brew}/opt` : "/dev/null",
		DYLD_CACHE: dyldCache,
	};
	const env = {
		HOME: join(scratch, "home"), TMPDIR: scratch, PATH: "/usr/bin:/bin", LANG: "C", TERM: "dumb",
		// Shared OpenSSL builds can otherwise open a host config during Node startup.
		// Pass an empty config to the worker and its children, without changing the host.
		OPENSSL_CONF: "/dev/null",
	};
	// Only a canonical managed checkout at the expected depth can use the managed profile.
	const pool = join(hostHome, ".codey", "worktrees");
	const bucket = dirname(workspace);
	const managed = dirname(bucket) === pool && /^task-[A-Za-z0-9]{6}$/.test(bucket.slice(pool.length + 1)) && gitStat?.isFile();
	const workerProfile = managed ? join(hostDir, "managed.sbpl") : profile;
	const execute = (name, args, signal) => runSeatbelt({ workspace, node, params, env, policy: workerProfile, name, args, signal });
	let reviewPolicy;
	async function review(signal) {
		if (!reviewPolicy) {
			// Resolve the system tool without Git or project discovery on the host.
			const git = appleGit();
			const path = join(hostDir, "review.sbpl");
			writeFileSync(path, `${readFileSync(workerProfile, "utf8")}\n${readFileSync(reviewRules, "utf8")}`, { mode: 0o600, flag: "wx" });
			reviewPolicy = {
				path, git, params: { ...params, REVIEW_GIT: git, REVIEW_GIT_LIB: join(dirname(dirname(git)), "lib"), REVIEW_GIT_DIR: gitFile },
			};
		}
		const reviewScratch = mkdtempSync("/private/tmp/codey-sandbox-review-");
		try {
			const home = join(reviewScratch, "home");
			mkdirSync(home, { mode: 0o700 });
			return await runSeatbelt({
				workspace, node, params: { ...reviewPolicy.params, SCRATCH: reviewScratch },
				env: { ...env, HOME: home, TMPDIR: reviewScratch },
				policy: reviewPolicy.path, name: "review", args: { git: reviewPolicy.git }, signal,
			});
		} finally {
			rmSync(reviewScratch, { recursive: true, force: true });
		}
	}
	try {
		mkdirSync(env.HOME, { mode: 0o700 });
		if (managed) writeFileSync(workerProfile, managedProfile(), { flag: "wx", mode: 0o600 });
		const hostProbe = join(hostDir, "denied-probe");
		writeFileSync(hostProbe, "sandbox probe", { mode: 0o600 });
		if (readFileSync(hostProbe, "utf8") !== "sandbox probe") throw new Error("Host preflight file is unreadable.");
		const result = await execute("ready", { hostProbe });
		if (!result.ready) throw new Error("Seatbelt worker did not complete its startup check.");
		return { execute, review, close, hostDir };
	} catch (error) {
		close();
		throw new Error(`Seatbelt startup failed: ${error.message}`);
	}
}

function runSeatbelt({ workspace, node, params, env, policy = profile, name, args, signal }) {
	const input = JSON.stringify({ name, args });
	if (Buffer.byteLength(input) > outputLimit) throw new Error("Tool input exceeds 1 MiB.");
	if (signal?.aborted) throw new Error("Operation cancelled.");
	const child = spawn(backend, [
		"-f", policy, ...Object.entries(params).flatMap(([key, value]) => ["-D", `${key}=${value}`]),
		node, "--import", resolver, worker,
	], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
	return new Promise((resolveResult, reject) => {
		const out = [], err = [];
		let bytes = 0;
		let failure;
		const terminate = (message) => {
			failure ??= new Error(message);
			try { process.kill(-child.pid, "SIGKILL"); } catch { /* Process group already exited. */ }
		};
		const seconds = name === "ready" ? 15 : name === "review" ? 20 : name === "bash" && Number.isFinite(args.timeout)
			? Math.min(120, Math.max(1, args.timeout))
			: 120;
		const timeout = setTimeout(() => terminate("Seatbelt worker timed out."), seconds * 1000);
		const cancel = () => terminate("Operation cancelled.");
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]]) {
			stream.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > outputLimit) terminate("Seatbelt worker output exceeded 1 MiB.");
				else chunks.push(chunk);
			});
		}
		child.on("error", (error) => { failure ??= error; });
		child.stdin.on("error", () => {});
		child.on("close", (code, exitSignal) => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", cancel);
			if (failure) return reject(failure);
			if (code !== 0) {
				const status = exitSignal ? `signal ${exitSignal}` : `status ${code}`;
				const diagnostics = Buffer.concat(err).toString().trim();
				return reject(new Error(`Seatbelt worker exited with ${status}.${diagnostics ? ` ${diagnostics}` : ""}`));
			}
			try {
				const result = JSON.parse(Buffer.concat(out).toString());
				if (result.error) throw new Error(result.error);
				resolveResult(result);
			} catch (error) {
				reject(error);
			}
		});
		child.stdin.end(input);
	});
}
