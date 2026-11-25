// Run bounded tools under the fixed macOS backend, using pipes and an allowlisted environment.
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const install = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
const backend = "/usr/bin/sandbox-exec";
const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const profile = fileURLToPath(new URL("./profile.sbpl", import.meta.url));
const resolver = pathToFileURL(join(install, "packages/coding-agent/src/experimental/source-resolver.ts")).href;
const outputLimit = 1024 * 1024;

export function contains(root, path) {
	const child = relative(root, path);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith("../"));
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
	};
	const env = { HOME: join(scratch, "home"), TMPDIR: scratch, PATH: "/usr/bin:/bin", LANG: "C", TERM: "dumb" };
	const execute = (name, args, signal) => runSeatbelt({ workspace, node, params, env, name, args, signal });
	try {
		mkdirSync(env.HOME, { mode: 0o700 });
		const hostProbe = join(hostDir, "denied-probe");
		writeFileSync(hostProbe, "sandbox probe", { mode: 0o600 });
		if (readFileSync(hostProbe, "utf8") !== "sandbox probe") throw new Error("Host preflight file is unreadable.");
		const result = await execute("ready", { hostProbe });
		if (!result.ready) throw new Error("Seatbelt worker did not complete its startup check.");
		return { execute, close, hostDir };
	} catch (error) {
		close();
		throw new Error(`Seatbelt startup failed: ${error.message}`);
	}
}

function runSeatbelt({ workspace, node, params, env, name, args, signal }) {
	const input = JSON.stringify({ name, args });
	if (Buffer.byteLength(input) > outputLimit) throw new Error("Tool input exceeds 1 MiB.");
	if (signal?.aborted) throw new Error("Operation cancelled.");
	const child = spawn(backend, [
		"-f", profile, ...Object.entries(params).flatMap(([key, value]) => ["-D", `${key}=${value}`]),
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
		const seconds = name === "ready" ? 15 : name === "bash" && Number.isFinite(args.timeout)
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
		child.on("close", (code) => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", cancel);
			if (failure) return reject(failure);
			if (code !== 0) return reject(new Error(Buffer.concat(err).toString().trim() || `Seatbelt worker exited with status ${code}.`));
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
