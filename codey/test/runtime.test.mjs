// Exercise the real CLI through the command users run, without provider traffic.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const executable = process.env.CODEY_TEST_BIN ?? join(root, "codey/bin/codey");
const manifest = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));

function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "codey-runtime-"));
	const attempts = join(dir, "network-attempts");
	t.after(() => {
		try {
			assert.equal(existsSync(attempts), false, "CLI attempted a network connection");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	const home = join(dir, "home");
	const agent = join(dir, "agent");
	const cwd = join(dir, "project with spaces");
	const bin = join(dir, "bin");
	for (const path of [home, agent, cwd, bin]) mkdirSync(path);
	symlinkSync(resolve(executable), join(bin, "codey"));
	const guard = join(dir, "no-network.mjs");
	writeFileSync(
		guard,
		`import { Socket } from 'node:net';
import { appendFileSync } from 'node:fs';
Socket.prototype.connect = function () {
  appendFileSync(${JSON.stringify(attempts)}, 'connect\\n');
  throw new Error('Network is disabled in Codey CLI smoke tests');
};\n`,
	);
	const env = {
		PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
		HOME: home,
		TERM: "dumb",
		NO_COLOR: "1",
		PI_OFFLINE: "1",
		PI_CODING_AGENT_DIR: agent,
		NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
	};
	return { agent, env, cwd };
}

function run(context, args, input = "") {
	const { env, cwd } = context;
	const result = spawnSync("codey", args, { env, cwd, encoding: "utf8", input, timeout: 60_000 });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	return result;
}

test("real codey --version reports the unchanged Pi package version", (t) => {
	const context = fixture(t);
	assert.equal(run(context, ["--version"]).stdout.trim(), manifest.version);
});

test("real codey --help exposes the upstream command options", (t) => {
	const context = fixture(t);
	const help = run(context, [
		"--help",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
	]).stdout;
	assert.match(help, /--mode/);
	assert.match(help, /--no-session/);
	assert.match(help, /--provider/);
	assert.match(help, /--model/);
});

test("real codey RPC reads state and messages, then exits on stdin EOF", (t) => {
	const context = fixture(t);
	writeFileSync(
		join(context.agent, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "test",
					models: [{ id: "fake-model" }],
				},
			},
		}),
	);
	writeFileSync(
		join(context.agent, "settings.json"),
		JSON.stringify({
			defaultProvider: "fake",
			defaultModel: "fake-model",
			enabledModels: ["fake/fake-model"],
		}),
	);
	const requests = [
		{ id: "state", type: "get_state" },
		{ id: "messages", type: "get_messages" },
	];
	const result = run(
		context,
		["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"],
		requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
	);
	const responses = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const state = responses.find((r) => r.id === "state");
	const messages = responses.find((r) => r.id === "messages");
	assert.equal(state?.success, true, result.stdout);
	assert.equal(state.data.model.provider, "fake");
	assert.equal(state.data.model.id, "fake-model");
	assert.equal(state.data.isStreaming, false);
	assert.equal(messages?.success, true, result.stdout);
	assert.deepEqual(messages.data.messages, []);
});
