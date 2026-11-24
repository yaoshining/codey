// Verify installed entry points against separate fake Codey and Pi user directories.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(realpathSync(tmpdir()), "codey-install-check-"));
const home = join(temporary, "home");
const cwd = join(temporary, "project");
const attempts = join(temporary, "network-attempts");
const oldAgent = join(home, ".pi/agent");
const newAgent = join(home, ".codey/agent");

function seedAgent(directory, provider) {
	mkdirSync(join(directory, "sessions/fixture"), { recursive: true });
	writeFileSync(
		join(directory, "models.json"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "fake-smoke-key",
					models: [{ id: provider }],
				},
			},
		}),
	);
	writeFileSync(
		join(directory, "settings.json"),
		JSON.stringify({
			defaultProvider: provider,
			defaultModel: provider,
			enabledModels: [`${provider}/${provider}`],
		}),
	);
	writeFileSync(
		join(directory, "auth.json"),
		JSON.stringify({ [provider]: { type: "api_key", key: "fake-smoke-key" } }),
	);
	writeFileSync(
		join(directory, "sessions/fixture/session.jsonl"),
		JSON.stringify({
			type: "session",
			version: 3,
			id: "11111111-1111-4111-8111-111111111111",
			timestamp: "2026-11-24T00:00:00.000Z",
			cwd,
		}) + "\n",
	);
}

function hashDirectory(directory) {
	const hash = createHash("sha256");
	for (const name of readdirSync(directory, { recursive: true }).sort()) {
		const path = join(directory, name);
		if (name.endsWith(".json") || name.endsWith(".jsonl")) hash.update(name).update(readFileSync(path));
	}
	return hash.digest("hex");
}

try {
	mkdirSync(cwd, { recursive: true });
	seedAgent(oldAgent, "install-pi");
	seedAgent(newAgent, "install-codey");
	const before = hashDirectory(oldAgent);
	const guard = join(temporary, "no-network.mjs");
	writeFileSync(
		guard,
		`import { Socket } from 'node:net';
import { appendFileSync } from 'node:fs';
Socket.prototype.connect = function () {
  appendFileSync(${JSON.stringify(attempts)}, 'connect\\n');
  throw new Error('Network is disabled in the Codey installation check');
};\n`,
	);
	// Do not inherit real config overrides, auth environment or preload scripts.
	const env = {
		PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
		HOME: home,
		PI_OFFLINE: "1",
		NO_COLOR: "1",
		TERM: "dumb",
		NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
	};
	const requests = [
		{ id: "state", type: "get_state" },
		{ id: "messages", type: "get_messages" },
	];
	const input = requests.map((request) => JSON.stringify(request)).join("\n") + "\n";
	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
	];
	for (const [entry, provider] of [
		[join(root, "codey/bin/codey"), "install-codey"],
		[join(root, "pi-test.sh"), "install-pi"],
	]) {
		const result = spawnSync(entry, args, { cwd, env, input, encoding: "utf8", timeout: 60_000 });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		const responses = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const state = responses.find((response) => response.id === "state");
		const messages = responses.find((response) => response.id === "messages");
		assert.equal(state?.success, true, result.stdout);
		assert.equal(state.data.model.provider, provider, "CLI read the wrong user directory");
		assert.equal(state.data.model.id, provider);
		assert.equal(messages?.success, true, result.stdout);
		assert.deepEqual(messages.data.messages, []);
		if (provider === "install-codey")
			assert.equal(hashDirectory(oldAgent), before, "Codey wrote into the old Pi fixture");
	}
	const version = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8")).version;
	console.log(
		`Codey ${version} installation check passed: default Codey/Pi RPC models differ; old Pi fixture SHA256 ${before} unchanged by Codey.`,
	);
} finally {
	try {
		assert.equal(existsSync(attempts), false, "Installation check attempted a network connection");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}
