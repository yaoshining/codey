// Start the whole Codey process in an offline Docker container.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createSnapshot, prepareSnapshot } from "./sandbox/snapshot.mjs";

const help = `Usage: codey sandbox --commit <ref> --image <local sha256:image-id> [--dry-run]

Start an offline Codey session from exactly the selected commit in the current repository.
Uncommitted, untracked and ignored files, and the source repository's Git metadata, are excluded.
Changes stay in a separate snapshot printed at startup. See codey/sandbox/README.md.`;
const localEngine = "unix:///var/run/docker.sock";
const daemonChecks = ["OSType", "MemoryLimit", "SwapLimit", "CPUCfsQuota", "PidsLimit", "SecurityOptions"];
const daemonFormat = daemonChecks.map((key) => `{{json .${key}}}`).join("\n");

try {
	const { values } = parseArgs({
		options: {
			commit: { type: "string" },
			image: { type: "string" },
			"dry-run": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(help);
	} else {
		run(values);
	}
} catch (error) {
	console.error(`Codey sandbox: ${error.message}`);
	process.exitCode = 1;
}

function run(values) {
	if (!values.commit || !/^sha256:[a-f0-9]{64}$/.test(values.image ?? "")) {
		throw new Error(help);
	}
	const snapshot = prepareSnapshot(process.cwd(), values.commit);
	if (values["dry-run"]) {
		console.log(JSON.stringify({
			commit: snapshot.commit,
			files: snapshot.files.length,
			scope: "Tracked files from the selected commit only. Local changes and source Git metadata are excluded.",
			result: join(snapshot.pool, "<unique task directory>", "project"),
			dockerArgs: dockerRunArgs("<new task project directory>", values.image, process.getuid?.(), process.getgid?.()),
		}, null, 2));
		return;
	}
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (process.platform !== "linux" || !uid || !gid || !process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("A Linux host, an interactive terminal, and a non-root host user and group are required.");
	}

	// Passing none of the user's environment also suppresses Docker proxy, context and credential config.
	// /dev/null is intentionally not a Docker config directory. Docker reads no config.json there.
	const dockerEnv = { PATH: process.env.PATH, HOME: "/dev/null", DOCKER_CONFIG: "/dev/null", LANG: "C" };
	const docker = (args, interactive = false) =>
		spawnSync("docker", ["--host", localEngine, ...args], {
			env: dockerEnv,
			encoding: "utf8",
			stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
			timeout: interactive ? undefined : 10_000,
		});
	const info = requireDocker(docker(["info", "--format", daemonFormat]));
	const [os, memory, swap, cpu, pids, security] = info.trim().split("\n").map((line) => JSON.parse(line));
	if (os !== "linux" || memory !== true || swap !== true || cpu !== true || pids !== true ||
		!security?.includes("name=seccomp,profile=builtin")) {
		throw new Error("Docker must report Linux, default seccomp, and CPU, memory, swap and PID limits. No sandbox was started.");
	}
	const manifest = JSON.parse(requireDocker(docker(["image", "inspect", "--format", "{{json .}}", values.image])));
	if (manifest.Id !== values.image || manifest.Os !== "linux" ||
		manifest.Config?.Labels?.["org.codey.sandbox"] !== "offline-v1" ||
		Object.keys(manifest.Config?.Volumes ?? {}).length) {
		throw new Error("Use a local image built from Codey's sandbox Dockerfile without image-declared volumes.");
	}

	const project = createSnapshot(snapshot);
	console.error(`Codey sandbox snapshot of ${snapshot.commit}: ${project}`);
	console.error("Uncommitted, untracked and ignored files were excluded. Results stay in this snapshot.");
	const config = join(project, "..", "docker-config");
	mkdirSync(config, { mode: 0o700 });
	const result = docker(["--config", config, ...dockerRunArgs(project, values.image, uid, gid)], true);
	if (result.error || result.signal) throw new Error(result.error?.message ?? `Docker ended with ${result.signal}.`);
	process.exitCode = result.status ?? 1;
}

function requireDocker(result) {
	if (result.error || result.status !== 0) {
		throw new Error(result.stderr?.trim() || result.error?.message || "Could not use the local Docker Engine.");
	}
	return result.stdout;
}

function dockerRunArgs(project, image, uid, gid) {
	return [
		"run", "--rm", "--pull=never", "--init", "--interactive", "--tty",
		"--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
		"--ipc=private", "--cgroupns=private", "--log-driver=none", "--shm-size=32m",
		"--cpus=1", "--memory=1g", "--memory-swap=1g", "--pids-limit=128",
		"--user", `${uid ?? "<uid>"}:${gid ?? "<gid>"}`,
		"--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
		"--mount", `type=bind,source=${project},target=/workspace,bind-recursive=disabled`,
		"--workdir", "/workspace", "--entrypoint", "/opt/codey/codey/sandbox/entry.sh", image,
	];
}
