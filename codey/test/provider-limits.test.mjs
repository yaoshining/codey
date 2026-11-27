import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { discoverModelLimits, providerFromProfile } from "../extensions/provider-protocols.mjs";

test("reads only authorized exact-route limits and sends a bounded Responses budget", async (t) => {
	const route = "vendor/fixture";
	const requests = [];
	const server = createServer(async (request, response) => {
		const { url } = request;
		if (request.method === "POST") {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			requests.push({ url, body: JSON.parse(Buffer.concat(chunks)), headers: request.headers });
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end('data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":0,"total_tokens":3}}}\n\n');
			return;
		}
		requests.push({ url, headers: request.headers });
		const send = (data) => response.setHeader("Content-Type", "application/json").end(JSON.stringify({ data }));
		if (url === "/v1/models") send([{ id: route, max_input_tokens: 999999, max_tokens: 999999 }]);
		else if (url === "/v1/model/info") send([
			{ model_name: "fixture", model_info: { context_window: 9000000, max_output_tokens: 9000000 } },
			{ model_name: route, model_info: { context_window: 128000, max_output_tokens: 8192, max_input_tokens: 80000 } },
			{ model_name: route, model_info: { context_window: 160000, max_output_tokens: 16384, ignored_secret: "not-persisted" } },
		]);
		else if (url === "/plain/models") send([{ id: route, max_input_tokens: 300000, max_tokens: 999999, context_window: "128000", max_output_tokens: -1 }]);
		else if (url === "/plain/model/info") response.writeHead(302, { Location: "/never" }).end();
		else if (url === "/claude/v1/models") send([{ type: "model", id: route, max_input_tokens: 200000, max_tokens: 8192 }]);
		else if (url === "/claude/v1/model/info") response.writeHead(401).end();
		else response.writeHead(500).end();
	});
	server.listen(0, "127.0.0.1");
	t.after(() => { server.closeAllConnections(); server.close(); });
	await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	const profile = { id: "relay", api: "openai-responses", auth: "key", key: "fixture-key", baseUrl: origin + "/v1", models: [route] };
	const detected = (await discoverModelLimits(profile, route)).limits;
	assert.deepEqual(detected, {
		contextWindow: { value: 128000, source: "Gateway model info" },
		maxTokens: { value: 8192, source: "Gateway model info" },
	});
	assert.deepEqual((await discoverModelLimits(profile, "unmatched/" + route)).limits, {});
	const plain = await discoverModelLimits({ ...profile, baseUrl: origin + "/plain" }, route);
	assert.deepEqual(plain.limits, {});
	assert.match(plain.reason, /redirected/);
	const claude = await discoverModelLimits({ ...profile, api: "anthropic-messages", baseUrl: origin + "/claude" }, route);
	assert.deepEqual(claude.limits, { maxTokens: { value: 8192, source: "Anthropic model catalog" } });
	assert.match(claude.reason, /401/);
	assert.ok(!requests.some(({ url }) => url === "/never"));
	assert.ok(requests.filter(({ url }) => !url.startsWith("/claude")).every(({ headers }) => headers.authorization === "Bearer fixture-key"));
	assert.ok(requests.filter(({ url }) => url.startsWith("/claude")).every(({ headers }) => headers["x-api-key"] === "fixture-key" && !headers.authorization));
	const plainProvider = providerFromProfile(profile);
	const configured = providerFromProfile({ ...profile, modelLimits: { [route]: { detected, manual: { maxTokens: 12000 } } } });
	const message = (content) => ({ messages: [{ role: "user", content, timestamp: 1 }] });
	const long = message("x".repeat(111552));
	assert.equal(estimateContextTokens(long).tokens, 31872);
	for (const [provider, context, expected] of [
		[plainProvider, message("short"), 4096], [plainProvider, long, 16],
		[configured, long, 12000],
	]) {
		const [model] = provider.getModels();
		const reply = await provider.streamSimple(model, context, {}).result();
		assert.notEqual(reply.stopReason, "error", reply.errorMessage);
		assert.equal(requests.at(-1).body.max_output_tokens, expected);
		assert.equal(requests.at(-1).body.model, route);
	}
	const [model] = configured.getModels();
	assert.equal(model.contextWindow, 128000);
	assert.equal(model.maxTokens, 12000);
	assert.equal(model.baseUrl, "");
	const reply = await configured.stream(model, long, { maxTokens: 50000 }).result();
	assert.notEqual(reply.stopReason, "error", reply.errorMessage);
	assert.equal(requests.at(-1).body.max_output_tokens, 12000);
});
