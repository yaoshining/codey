import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { discoverModels } from "../extensions/provider-protocols.mjs";

test("catalog continuation stays on the approved path and stops repeated pages and redirects", async (t) => {
	const requests = [];
	const server = createServer((request, response) => {
		requests.push(request.url);
		const { pathname, searchParams } = new URL(request.url, "http://127.0.0.1");
		const cursor = Number(searchParams.get("after"));
		response.setHeader("Content-Type", "application/json");
		const data = [{ id: `model-${cursor}` }];
		if (pathname === "/bounded/models") {
			response.end(JSON.stringify({ data, has_more: cursor < 65, last_id: String(cursor + 1) }));
		} else if (pathname === "/repeated/models") {
			response.end(JSON.stringify({ data, next: "?after=1" }));
		} else if (pathname === "/wrong-path/models") {
			response.end(JSON.stringify({ data, next: "/unexpected" }));
		} else if (pathname === "/wrong-origin/models") {
			response.end(JSON.stringify({ data, next: `http://localhost:${server.address().port}${pathname}` }));
		} else if (pathname === "/redirect/models") {
			response.writeHead(302, { Location: "/unexpected" }).end();
		} else {
			response.writeHead(500).end();
		}
	});
	server.listen(0, "127.0.0.1");
	t.after(() => { server.closeAllConnections(); server.close(); });
	await once(server, "listening");
	const profile = (segment) => ({ baseUrl: `http://127.0.0.1:${server.address().port}/${segment}`, api: "openai-completions", auth: "none" });

	const first = await discoverModels(profile("bounded"));
	assert.equal(first.partial, true);
	assert.equal(first.ids.length, 64);
	assert.ok(first.continuation);
	const final = await discoverModels(profile("bounded"), first.continuation);
	assert.equal(final.reason, undefined);
	assert.equal(final.ids.length, 66);
	assert.equal(new Set(requests).size, 66);
	assert.equal(requests.length, 66);

	for (const [segment, count, reason] of [
		["repeated", 2, /repeated a page/],
		["wrong-path", 1, /leave the approved endpoint/],
		["wrong-origin", 1, /leave the approved endpoint/],
		["redirect", 1, /catalog redirected/],
	]) {
		requests.length = 0;
		const interrupted = await discoverModels(profile(segment));
		assert.equal(interrupted.partial, true);
		assert.match(interrupted.reason, reason);
		assert.equal(interrupted.continuation, undefined);
		assert.equal(requests.length, count);
		assert.ok(requests.every((url) => url.startsWith(`/${segment}/models`)));
	}
});
