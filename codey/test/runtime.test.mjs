// Exercise installed and source entries with isolated, synthetic user data and no provider traffic.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codeyVersion } from "../version.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const executable = process.env.CODEY_TEST_BIN ?? join(root, "codey/bin/codey");
const manifest = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));
const noResources = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"];

function fixture(t) {
	// macOS exposes /tmp through /private/tmp; session paths use canonical cwd values.
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "codey-runtime-")));
	const attempts = join(directory, "network-attempts");
	t.after(() => {
		assert.equal(
			existsSync(attempts),
			false,
			`CLI attempted a network connection; evidence retained in ${directory}`,
		);
		rmSync(directory, { recursive: true, force: true });
	});
	const home = join(directory, "home ' #?%");
	const agent = join(home, ".codey/agent");
	const legacy = join(home, ".pi/agent");
	const cwd = join(directory, "project with spaces");
	const bin = join(directory, "bin");
	for (const path of [home, cwd, bin]) mkdirSync(path);
	symlinkSync(resolve(executable), join(bin, "codey"));
	const guard = join(directory, "no-network.mjs");
	writeFileSync(
		guard,
		`import { Socket } from "node:net";
import { appendFileSync } from "node:fs";
Socket.prototype.connect = function () {
  appendFileSync(${JSON.stringify(attempts)}, "connect\\n");
  throw new Error("Network is disabled in Codey CLI tests");
};\n`,
	);
	const env = {
		PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
		HOME: home,
		TERM: "dumb",
		NO_COLOR: "1",
		PI_OFFLINE: "1",
		NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
	};
	return { directory, home, agent, legacy, env, cwd };
}

function json(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

function session(context, directory, label, provider, model) {
	mkdirSync(directory, { recursive: true });
	const timestamp = "2026-01-01T00:00:00.000Z";
	const id = randomUUID();
	const file = join(directory, `${label}.jsonl`);
	const entries = [
		{ type: "session", version: 3, id, timestamp, cwd: context.cwd },
		{ type: "model_change", id: "model", parentId: null, timestamp, provider, modelId: model },
		{ type: "session_info", id: "name", parentId: "model", timestamp, name: `${label} session` },
		{
			type: "message",
			id: "message",
			parentId: "name",
			timestamp,
			message: {
				role: "user",
				content: `${label} synthetic history`,
				timestamp: Date.parse(timestamp),
			},
		},
	];
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return { file, id, label };
}

function seed(context, label, directory) {
	const provider = `fixture-${label}`;
	const model = `model-${label}`;
	const key = `${label}-synthetic-key`;
	json(join(directory, "models.json"), {
		providers: {
			[provider]: {
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				models: [{ id: model }],
			},
		},
	});
	json(join(directory, "auth.json"), { [provider]: { type: "api_key", key } });
	json(join(directory, "settings.json"), {
		defaultProvider: provider,
		defaultModel: model,
		enabledModels: [`${provider}/${model}`],
		theme: "dark",
	});
	const encodedCwd = `--${context.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const saved = session(context, join(directory, "sessions", encodedCwd), label, provider, model);
	return { provider, model, key, saved };
}

function tree(path) {
	const result = {};
	function visit(current, relative) {
		const stat = lstatSync(current, { bigint: true });
		result[relative] = {
			mode: stat.mode,
			mtime: stat.mtimeNs,
			ctime: stat.ctimeNs,
			content: stat.isDirectory() ? null : createHash("sha256").update(readFileSync(current)).digest("hex"),
		};
		if (stat.isDirectory()) {
			for (const name of readdirSync(current).sort()) visit(join(current, name), join(relative, name));
		}
	}
	visit(path, ".");
	return result;
}

function run(context, args, options = {}) {
	const command = options.command === "pi" ? join(root, "pi-test.sh") : "codey";
	const result = spawnSync(command, args, {
		env: { ...context.env, ...options.env },
		cwd: context.cwd,
		encoding: "utf8",
		input: options.input ?? "",
		timeout: 60_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	return result;
}

function rpc(context, options = {}) {
	const requests = [
		{ id: "state", type: "get_state" },
		{ id: "messages", type: "get_messages" },
	];
	const result = run(context, ["--mode", "rpc", ...noResources, ...(options.args ?? ["--no-session"])], {
		...options,
		input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
	});
	const responses = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const state = responses.find((response) => response.id === "state");
	const messages = responses.find((response) => response.id === "messages");
	assert.equal(state?.success, true, result.stdout);
	assert.equal(messages?.success, true, result.stdout);
	assert.equal(state.data.isStreaming, false);
	return { state: state.data, messages: messages.data.messages, stderr: result.stderr };
}

function assertModel(state, expected) {
	assert.equal(state.model.provider, expected.provider);
	assert.equal(state.model.id, expected.model);
}

test("Codey separates its own version from the Pi runtime version and keeps source resources", (t) => {
	const context = fixture(t);
	assert.equal(run(context, ["--version"]).stdout.trim(), codeyVersion);
	assert.equal(run(context, ["-v"]).stdout.trim(), codeyVersion);
	assert.equal(run(context, ["--offline", "--version"]).stdout.trim(), codeyVersion);
	assert.equal(run(context, ["--pi-version"]).stdout.trim(), manifest.version);
	assert.equal(run(context, ["--version"], { command: "pi" }).stdout.trim(), manifest.version);
	assert.equal(run(context, ["--codey-version"]).stdout.trim(), codeyVersion);
	const data = seed(context, "codey", context.agent);
	const state = rpc(context);
	assertModel(state.state, data);
	assert.doesNotMatch(state.stderr, /unknown theme|failed to load theme/i);
	const output = join(context.cwd, "export ' #?%.html");
	run(context, ["--export", data.saved.file, output]);
	const html = readFileSync(output, "utf8");
	assert.match(html, /<!doctype html>/i);
	const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html);
	assert.ok(encoded, "export must embed the synthetic session");
	const exported = JSON.parse(Buffer.from(encoded[1], "base64").toString("utf8"));
	assert.equal(exported.header.id, data.saved.id);
	assert.equal(exported.entries.find((entry) => entry.type === "message").message.content, "codey synthetic history");
});

test("default codey and stock Pi read separate models, auth and sessions under the same HOME", (t) => {
	const context = fixture(t);
	const codey = seed(context, "codey", context.agent);
	const pi = seed(context, "pi", context.legacy);
	const oldBefore = tree(join(context.home, ".pi"));
	const current = rpc(context, { args: ["--continue"] });
	assertModel(current.state, codey);
	assert.equal(current.state.sessionFile, codey.saved.file);
	assert.equal(current.state.sessionName, "codey session");
	assert.equal(current.messages[0].content, "codey synthetic history");
	const codeyKey = run(context, ["auth", "print-api-key", "--provider", codey.provider]);
	assert.equal(codeyKey.stdout.trim(), codey.key);
	assert.deepEqual(tree(join(context.home, ".pi")), oldBefore, "default Codey must not write or migrate the old tree");
	const newBefore = tree(join(context.home, ".codey"));
	const original = rpc(context, { command: "pi", args: ["--continue"] });
	assertModel(original.state, pi);
	assert.equal(original.state.sessionFile, pi.saved.file);
	assert.equal(original.state.sessionName, "pi session");
	assert.equal(original.messages[0].content, "pi synthetic history");
	assert.equal(
		run(context, ["auth", "print-api-key", "--provider", pi.provider], { command: "pi" }).stdout.trim(),
		pi.key,
	);
	assert.deepEqual(tree(join(context.home, ".codey")), newBefore, "stock Pi must not use the new Codey tree");
});

test("an empty default installation creates only the new Codey state directory", (t) => {
	const context = fixture(t);
	run(context, ["--help", ...noResources]);
	assert.equal(existsSync(context.agent), true);
	assert.equal(existsSync(join(context.home, ".pi")), false);
});

test("Codey main and auth help show the effective path while stock Pi help stays original", (t) => {
	const context = fixture(t);
	const help = run(context, ["--help", ...noResources]).stdout;
	assert.match(help, /^codey - AI coding assistant/m);
	assert.match(help, /  codey \[options\]/);
	assert.match(help, /enter \/quit to exit/);
	assert.doesNotMatch(help, /\/exit\b/);
	assert.match(help, /--codey-version/);
	assert.match(help, /--pi-version/);
	assert.ok(help.includes(context.agent));
	const exportPath = join(context.agent, "sessions/--path--/session.jsonl");
	assert.ok(help.includes("'" + exportPath.replaceAll("'", "'\\''") + "'"), "export path must be shell quoted");
	for (const option of ["--mode", "--no-session", "--provider", "--model"]) assert.ok(help.includes(option));
	const auth = run(context, ["auth", "--help"]).stdout;
	assert.match(auth, /  codey auth login/);
	assert.ok(auth.includes(join(context.agent, "auth.json")));
	assert.doesNotMatch(auth, /  pi auth|~\/\.pi\/agent\/auth\.json/);
	const original = run(context, ["--help", ...noResources], { command: "pi" }).stdout;
	assert.match(original, /^pi - AI coding assistant/m);
	assert.match(original, /  pi \[options\]/);
	assert.match(original, /^  # Interactive mode$/m);
	assert.ok(original.includes("Config directory (default: ~/.pi/agent)"));
	assert.ok(original.includes("pi --export ~/.pi/agent/sessions/--path--/session.jsonl"));
	assert.doesNotMatch(original, /codey -|  codey /);
	assert.doesNotMatch(original, /--(?:codey|pi)-version/);
	for (const command of ["install", "remove", "list", "config", "update", "mcp"]) {
		const usage = new RegExp(`^  codey ${command}\\b`, "m");
		assert.match(run(context, [command, "--help"]).stdout, usage);
		assert.doesNotMatch(run(context, [command, "--help"], { command: "pi" }).stdout, usage);
	}
	const originalAuth = run(context, ["auth", "--help"], { command: "pi" }).stdout;
	assert.match(originalAuth, /  pi auth login/);
	assert.ok(originalAuth.includes("Credentials are stored in ~/.pi/agent/auth.json."));
});

test("nonempty Codey configuration overrides win over explicit legacy overrides", (t) => {
	const context = fixture(t);
	const defaultData = seed(context, "default", context.agent);
	const oldDirectory = join(context.directory, "explicit old agent");
	const newDirectory = join(context.directory, "explicit new agent");
	const oldData = seed(context, "old", oldDirectory);
	const newData = seed(context, "new", newDirectory);
	const cases = [
		{ env: { PI_CODING_AGENT_DIR: oldDirectory }, expected: oldData, path: oldDirectory },
		{ env: { CODEY_CODING_AGENT_DIR: newDirectory }, expected: newData, path: newDirectory },
		{
			env: { CODEY_CODING_AGENT_DIR: newDirectory, PI_CODING_AGENT_DIR: oldDirectory },
			expected: newData,
			path: newDirectory,
		},
		{ env: { CODEY_CODING_AGENT_DIR: "", PI_CODING_AGENT_DIR: oldDirectory }, expected: oldData, path: oldDirectory },
		{ env: { CODEY_CODING_AGENT_DIR: "", PI_CODING_AGENT_DIR: "" }, expected: defaultData, path: context.agent },
	];
	for (const entry of cases) {
		assertModel(rpc(context, { env: entry.env }).state, entry.expected);
		assert.ok(run(context, ["auth", "--help"], { env: entry.env }).stdout.includes(join(entry.path, "auth.json")));
	}
});

test("explicit reuse of old data keeps Pi's writable migration behavior", (t) => {
	const context = fixture(t);
	const old = seed(context, "old", context.legacy);
	const commands = join(context.legacy, "commands");
	mkdirSync(commands);
	writeFileSync(join(commands, "legacy.md"), "Synthetic legacy prompt\n");
	assertModel(rpc(context, { env: { PI_CODING_AGENT_DIR: context.legacy } }).state, old);
	assert.equal(existsSync(commands), false);
	assert.equal(readFileSync(join(context.legacy, "prompts/legacy.md"), "utf8"), "Synthetic legacy prompt\n");
});

test("session overrides retain Codey, legacy and command-line precedence", (t) => {
	const context = fixture(t);
	const data = seed(context, "codey", context.agent);
	const legacyDir = join(context.directory, "legacy sessions");
	const codeyDir = join(context.directory, "codey sessions");
	const cliDir = join(context.directory, "command-line sessions");
	const old = session(context, legacyDir, "legacy-location", data.provider, data.model);
	const current = session(context, codeyDir, "codey-location", data.provider, data.model);
	const cli = session(context, cliDir, "cli-location", data.provider, data.model);
	const cases = [
		{ env: { PI_CODING_AGENT_SESSION_DIR: legacyDir }, expected: old },
		{ env: { CODEY_CODING_AGENT_SESSION_DIR: codeyDir }, expected: current },
		{ env: { CODEY_CODING_AGENT_SESSION_DIR: codeyDir, PI_CODING_AGENT_SESSION_DIR: legacyDir }, expected: current },
		{ env: { CODEY_CODING_AGENT_SESSION_DIR: "", PI_CODING_AGENT_SESSION_DIR: legacyDir }, expected: old },
		{
			env: { CODEY_CODING_AGENT_SESSION_DIR: codeyDir, PI_CODING_AGENT_SESSION_DIR: legacyDir },
			args: ["--continue", "--session-dir", cliDir],
			expected: cli,
		},
	];
	for (const entry of cases) {
		const state = rpc(context, { env: entry.env, args: entry.args ?? ["--continue"] }).state;
		assert.equal(state.sessionFile, entry.expected.file);
		assert.equal(state.sessionName, `${entry.expected.label} session`);
	}
});

test("project .pi extensions remain subject to the upstream trust gate", (t) => {
	const context = fixture(t);
	const directory = join(context.cwd, ".pi/extensions");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "probe.ts"),
		'export default function (pi) { pi.registerFlag("project-probe", { type: "boolean", description: "Synthetic project extension" }); }\n',
	);
	const args = ["--help", "--no-skills", "--no-prompt-templates", "--no-themes"];
	assert.ok(run(context, [...args, "--approve"]).stdout.includes("--project-probe"));
	assert.equal(run(context, [...args, "--no-approve"]).stdout.includes("--project-probe"), false);
	assert.equal(existsSync(join(context.home, ".pi")), false);
});
