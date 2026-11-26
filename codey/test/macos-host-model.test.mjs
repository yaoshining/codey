// Exercise the macOS host model bootstrap without invoking Seatbelt or a provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const resolver = new URL("../../packages/coding-agent/src/experimental/source-resolver.ts", import.meta.url);
const hostModule = new URL("../sandbox/macos/host-model.mjs", import.meta.url);

test("host model startup restores local availability without catalog or OAuth network access", (t) => {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "codey-host-model-")));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	const script = `
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { hostModel } from ${JSON.stringify(hostModule.href)};

let connections = 0;
function noNetwork() {
	connections++;
	throw new Error("Unexpected startup network access");
}
Socket.prototype.connect = noNetwork;
globalThis.fetch = noNetwork;
const root = process.argv[1];
const home = join(root, "home");
const workspace = join(root, "project");
const hostDir = join(root, "host");
const agent = join(home, ".codey", "agent");
mkdirSync(agent, { recursive: true });
mkdirSync(workspace);
mkdirSync(hostDir);
const auth = join(agent, "auth.json");
const cache = join(agent, "models-store.json");
async function runtime() {
	const result = await hostModel(home, workspace, hostDir);
	assert.equal(result.warning, undefined);
	return result.runtime;
}

const empty = await runtime();
assert.deepEqual(empty.getAvailableSnapshot(), []);
assert.equal(existsSync(cache), false);
const builtin = empty.getModel("openai", "gpt-6-luna");
assert.ok(builtin);
process.env.OPENAI_API_KEY = "synthetic-env-key";
const withEnvKey = await runtime();
assert.ok(withEnvKey.getAvailableSnapshot().some((model) => model.provider === "openai" && model.id === builtin.id));
delete process.env.OPENAI_API_KEY;

const credentials = { openai: { type: "api_key", key: "synthetic-key" },
	"openai-codex": { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 0 } };
writeFileSync(auth, JSON.stringify(credentials));
const catalog = JSON.stringify({ openai: { lastModified: Number.MAX_SAFE_INTEGER,
	models: [{ ...builtin, id: "synthetic-cached-model" }] } });
writeFileSync(cache, catalog);
const warmed = await runtime();
const available = warmed.getAvailableSnapshot();
assert.ok(available.some(({ provider, id }) => provider === "openai" && id === "synthetic-cached-model"));
assert.ok(available.some(({ provider, id }) => provider === "openai-codex" && id === "gpt-6-luna"));
assert.equal(warmed.isUsingOAuth("openai-codex"), true);
assert.equal(existsSync(join(agent, "models.json")), false);
assert.equal(readFileSync(cache, "utf8"), catalog);
assert.deepEqual(JSON.parse(readFileSync(auth, "utf8")), credentials);

const profiles = join(agent, "custom-providers");
mkdirSync(profiles);
for (const [id, api, authMode, baseUrl] of [
	["fixture-response", "openai-responses", "none", "http://127.0.0.1:9/v1"],
	["fixture-chat", "openai-completions", "key", "http://127.0.0.1:9/v1"],
	["fixture-messages", "anthropic-messages", "key", "http://127.0.0.1:9"],
]) {
	writeFileSync(join(profiles, id + ".json"), JSON.stringify({
		id, api, baseUrl, auth: authMode, key: "synthetic-key", models: ["fixture"],
	}), { mode: 0o600 });
}
const withProfiles = await runtime();
for (const provider of ["fixture-response", "fixture-chat", "fixture-messages"]) {
	assert.ok(withProfiles.hasConfiguredAuth(provider));
	assert.ok(withProfiles.getAvailableSnapshot().some(({ provider: id }) => id === provider));
}
assert.equal(connections, 0);
`;
	const result = spawnSync(process.execPath, ["--import", resolver.href, "--input-type=module", "-e", script, fixture], {
		cwd: fixture,
		env: { HOME: fixture, PATH: process.env.PATH },
		encoding: "utf8",
		timeout: 25_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
});
