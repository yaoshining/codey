// Checks pinned model metadata hydration with local archives and mocked fetch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModelDataManifest, validateGeneratedModelData } from "../../packages/ai/scripts/model-data.ts";
import { hydrateModelData } from "../hydrate-model-data.mjs";

const metadataUrl = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.6.0.tgz";

function fixture(t, invalidManifest = false) {
	const directory = mkdtempSync(join(tmpdir(), "codey-model-data-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const root = join(directory, "checkout ' #?%");
	const packageRoot = join(root, "packages/ai");
	const providers = join(packageRoot, "src/providers");
	const data = join(providers, "data");
	const archiveRoot = join(directory, "archive");
	const archivedData = join(archiveRoot, "package/dist/providers/data");
	mkdirSync(providers, { recursive: true });
	mkdirSync(join(root, "codey"));
	mkdirSync(archivedData, { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "1.6.0" }));
	writeFileSync(
		join(packageRoot, "src/models.generated.ts"),
		'import { FAKE_CLASSIFIER_MODELS, FAKE_IMAGE_MODELS, FAKE_MODELS } from "./providers/fake.models.ts";\n',
	);
	writeFileSync(join(providers, "fake.models.ts"), "// Fixture source shard.\n");
	const model = {
		id: "fake-model",
		provider: "fake",
		api: "openai-completions",
		type: "chat",
		name: "Offline fixture model",
		baseUrl: "http://127.0.0.1:1",
		input: ["text"],
		reasoning: false,
		contextWindow: 4096,
		maxTokens: 512,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const content = JSON.stringify({ "openai-completions": { "chat:fake-model": model } });
	const manifest = createModelDataManifest(
		{ fake: { "chat:fake-model": "openai-completions" } },
		{ "fake.json": content },
		"2026-11-24T00:00:00.000Z",
	);
	if (invalidManifest) manifest.files["fake.json"] = "0".repeat(64);
	const manifestContent = JSON.stringify(manifest);
	writeFileSync(join(archivedData, "fake.json"), content);
	writeFileSync(join(archivedData, ".manifest.json"), manifestContent);
	writeFileSync(join(archiveRoot, "package/dist/index.js"), "throw new Error('must not copy executable code');\n");
	const archive = join(directory, "metadata.tgz");
	const tar = spawnSync("tar", ["-czf", archive, "-C", archiveRoot, "package"], { encoding: "utf8" });
	assert.ifError(tar.error);
	assert.equal(tar.status, 0, tar.stderr);
	const bytes = readFileSync(archive);
	const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	writeFileSync(
		join(root, "codey/model-data.json"),
		JSON.stringify({ version: "1.6.0", url: metadataUrl, integrity }),
	);
	return { root, packageRoot, data, bytes, content, manifestContent };
}

function mockArchiveFetch(t, bytes, status = 200) {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (url, options) => {
		calls.push({ url, options });
		return new Response(bytes, { status });
	});
	return calls;
}

test("hydrates only pinned metadata and validates the upstream manifest", async (t) => {
	const { root, packageRoot, data, bytes, content, manifestContent } = fixture(t);
	const calls = mockArchiveFetch(t, bytes);
	await hydrateModelData(root);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, metadataUrl);
	assert.equal(calls[0].options.redirect, "error");
	assert.ok(calls[0].options.signal instanceof AbortSignal);
	assert.equal(readFileSync(join(data, "fake.json"), "utf8"), content);
	assert.equal(readFileSync(join(data, ".manifest.json"), "utf8"), manifestContent);
	assert.equal(existsSync(join(packageRoot, "dist")), false);
	assert.doesNotThrow(() => validateGeneratedModelData(packageRoot));
});

test("rejects a tampered archive before modifying the destination", async (t) => {
	const { root, data, bytes } = fixture(t);
	mkdirSync(data);
	writeFileSync(join(data, "existing.json"), "preserve existing metadata\n");
	const tampered = Buffer.from(bytes);
	tampered[tampered.length - 1] ^= 1;
	const calls = mockArchiveFetch(t, tampered);
	await assert.rejects(hydrateModelData(root), /integrity|sha512|checksum/i);
	assert.equal(calls.length, 1);
	assert.equal(readFileSync(join(data, "existing.json"), "utf8"), "preserve existing metadata\n");
	assert.equal(existsSync(join(data, "fake.json")), false);
});

test("rejects metadata with an invalid manifest even when archive integrity matches", async (t) => {
	const { root, data, bytes } = fixture(t, true);
	mkdirSync(data);
	writeFileSync(join(data, "existing.json"), "preserve existing metadata\n");
	mockArchiveFetch(t, bytes);
	await assert.rejects(hydrateModelData(root), /manifest hash|Invalid generated model data/i);
	assert.equal(readFileSync(join(data, "existing.json"), "utf8"), "preserve existing metadata\n");
	assert.equal(existsSync(join(data, "fake.json")), false);
});

test("rejects a source version mismatch before fetching", async (t) => {
	const { root, packageRoot, data, bytes } = fixture(t);
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "1.7.0" }));
	const calls = mockArchiveFetch(t, bytes);
	await assert.rejects(hydrateModelData(root), /version|1\.7\.0|1\.6\.0/i);
	assert.equal(calls.length, 0);
	assert.equal(existsSync(data), false);
});

test("rejects HTTP errors without writing metadata", async (t) => {
	const { root, data, bytes } = fixture(t);
	const calls = mockArchiveFetch(t, bytes, 503);
	await assert.rejects(hydrateModelData(root), /503|http|fetch|download/i);
	assert.equal(calls.length, 1);
	assert.equal(existsSync(data), false);
});
