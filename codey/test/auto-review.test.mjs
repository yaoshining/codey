import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.ts";
import { createAutoReviewer } from "../sandbox/auto-review.mjs";

const provider = "review-fixture";
const modelId = "isolated-reviewer";
const model = { provider, id: modelId };
const action = (fields = {}) => ({
	id: randomUUID().replaceAll("-", ""), kind: "workspace-edit", boundary: "eligible", byteCount: 32,
	fingerprint: createHash("sha256").update("synthetic content").digest("hex"), ...fields,
});
const response = (text, stopReason = "stop") => ({ stopReason, content: [{ type: "text", text }] });
const reviewIdFrom = (context) => JSON.parse(context.messages[0].content).reviewId;
const allow = (context) => response(JSON.stringify({ reviewId: reviewIdFrom(context), recommendation: "allow" }));
const reviewer = (complete, overrides = {}) => createAutoReviewer({
	enabled: true, provider, modelId, runtime: { getModel: () => model, complete: async (...args) => complete(...args) }, ...overrides,
});

test("disabled, unavailable and boundary-denied actions make no request", async () => {
	let calls = 0;
	const never = () => { calls++; };
	assert.equal((await reviewer(never, { enabled: undefined })(action())).reason, "disabled");
	assert.equal((await reviewer(never, { provider: undefined })(action())).reason, "unavailable");
	assert.equal((await reviewer(never, { modelId: "different" })(action())).reason, "unavailable");
	const review = reviewer(never);
	for (const fields of [
		{ boundary: "hard-deny" }, { boundary: undefined }, { kind: "command" }, { kind: "mcp" },
		{ kind: "network" }, { kind: "git" }, { fingerprint: "bad" }, { byteCount: 65_537 },
	]) assert.equal((await review(action(fields))).reason, "boundary");
	const hardDenied = action({ boundary: "hard-deny" });
	assert.equal((await review(hardDenied)).reason, "boundary");
	assert.equal((await review({ ...hardDenied, boundary: "eligible" })).reason, "duplicate-or-limit");
	assert.equal(calls, 0);
});

test("review is isolated and advisory, and a duplicate action cannot start another review", async () => {
	let release;
	let captured;
	const review = reviewer((selected, context, options) => {
		captured = { selected, context, options };
		return new Promise((resolve) => { release = () => resolve(allow(context)); });
	});
	const candidate = action({ path: "/synthetic-private", prompt: "PRIVATE_HISTORY", credential: "PRIVATE_KEY" });
	const fingerprint = candidate.fingerprint;
	const pending = review(candidate);
	assert.equal((await review({ ...candidate })).reason, "duplicate-or-limit");
	candidate.fingerprint = "a".repeat(64);
	release();
	assert.deepEqual(await pending, { recommendation: "would-allow", actionId: candidate.id, fingerprint });
	assert.equal((await review(candidate)).reason, "duplicate-or-limit");
	assert.equal(captured.selected, model);
	assert.deepEqual(captured.context.tools, []);
	assert.deepEqual(Object.keys(JSON.parse(captured.context.messages[0].content)).sort(), ["byteCount", "kind", "reviewId"]);
	assert.equal(captured.context.messages.length, 1);
	assert.doesNotMatch(JSON.stringify(captured.context), /synthetic-private|PRIVATE_HISTORY|PRIVATE_KEY/);
	assert.equal(captured.options.cacheRetention, "none");
});

test("model errors, malformed, replayed, truncated and tool-call replies deny", async () => {
	let previous;
	const review = reviewer((_, context) => {
		if (previous) return previous;
		previous = allow(context);
		return previous;
	});
	assert.equal((await review(action())).recommendation, "would-allow");
	assert.equal((await review(action())).reason, "invalid-output");
	for (const complete of [
		(_, context) => response(JSON.stringify({ reviewId: reviewIdFrom(context), recommendation: "deny" })),
		(_, context) => ({ ...allow(context), stopReason: "length" }),
		(_, context) => ({ stopReason: "stop", content: [...allow(context).content, { type: "toolCall", name: "write" }] }),
		(_, context) => response(allow(context).content[0].text.replace("}", ',"recommendation":"allow"}')),
		() => response("not-json"),
		() => { throw new Error("synthetic transport failure"); },
	]) assert.equal((await reviewer(complete)(action())).recommendation, "deny");
});

test("timeout and abort deny even if the backend ignores cancellation", async () => {
	const eventLoop = delay(100);
	try {
		const stalled = reviewer(() => new Promise(() => {}), { timeoutMs: 10 });
		assert.equal((await stalled(action())).reason, "timeout");
		const controller = new AbortController();
		const candidate = action();
		const review = reviewer(async (_, context) => { await delay(25); return allow(context); });
		const pending = review(candidate, controller.signal);
		controller.abort();
		assert.equal((await pending).reason, "cancelled");
		assert.equal((await review(candidate)).reason, "duplicate-or-limit");
	} finally {
		await eventLoop;
	}
});

test("the real model runtime sends only an independent, tool-free request to the selected loopback model", async (t) => {
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks));
		requests.push({ url: req.url, body });
		const reviewId = JSON.parse(body.messages.at(-1).content).reviewId;
		const fragment = (delta, finish_reason) => `data: ${JSON.stringify({
			id: "review", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason }],
		})}\n\n`;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(fragment({ role: "assistant", content: JSON.stringify({ reviewId, recommendation: "allow" }) }, null) +
			fragment({}, "stop") + "data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const root = await mkdtemp(join(tmpdir(), "codey-auto-review-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const modelsPath = join(root, "models.json");
	await writeFile(modelsPath, JSON.stringify({ providers: { [provider]: {
		api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		models: [{ id: modelId }, { id: "main-model" }],
	} } }));
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ [provider]: { type: "api_key", key: "synthetic" } }),
		modelsPath, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false,
	});
	t.after(() => runtime.settleCredentialWrites());
	const review = createAutoReviewer({ enabled: true, provider, modelId, runtime });
	assert.equal((await review(action())).recommendation, "would-allow");
	assert.equal(requests.length, 1);
	const [{ url, body }] = requests;
	assert.equal(url, "/v1/chat/completions");
	assert.equal(body.model, modelId);
	assert.ok(body.tools === undefined || body.tools.length === 0);
	assert.deepEqual(body.messages.map(({ role }) => role), ["system", "user"]);
	const metadata = JSON.parse(body.messages[1].content);
	assert.equal(metadata.kind, "workspace-edit");
	assert.equal(metadata.byteCount, 32);
});
