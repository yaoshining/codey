// Share Pi's tool schemas with the host, and execute their handlers only in the worker.
import { spawn } from "node:child_process";
import { createBashToolDefinition } from "../../../packages/coding-agent/src/core/tools/bash.ts";
import { createEditToolDefinition } from "../../../packages/coding-agent/src/core/tools/edit.ts";
import { createLsToolDefinition } from "../../../packages/coding-agent/src/core/tools/ls.ts";
import { createReadToolDefinition } from "../../../packages/coding-agent/src/core/tools/read.ts";
import { createWriteToolDefinition } from "../../../packages/coding-agent/src/core/tools/write.ts";

export function toolDefinitions(cwd) {
	return [
		createReadToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createLsToolDefinition(cwd),
		createBashToolDefinition(cwd, {
			exposeSessionEnvironment: false,
			operations: {
				exec: (command, directory, { onData }) => new Promise((resolve, reject) => {
					// Keep descendants in the worker's process group. The host owns its deadline.
					const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
						cwd: directory, env: process.env, stdio: ["ignore", "pipe", "pipe"],
					});
					child.stdout.on("data", onData);
					child.stderr.on("data", onData);
					child.once("error", reject);
					child.once("close", (exitCode) => resolve({ exitCode }));
				}),
			},
		}),
	];
}
