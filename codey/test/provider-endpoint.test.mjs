import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { authorizedProviderEndpoint, fetchProvider, providerEndpoint } from "../extensions/provider-endpoint.mjs";

test("provider plaintext accepts only unambiguous local literals or hostnames requiring runtime checks", () => {
	const api = "openai-completions";
	for (const [input, baseUrl, lanHttp] of [
		["http://127.0.0.1:8080/v1/", "http://127.0.0.1:8080/v1", false],
		["http://[::1]:8080", "http://[::1]:8080", false],
		["http://10.5.6.7", "http://10.5.6.7", true],
		["http://172.16.0.1", "http://172.16.0.1", true],
		["http://172.31.255.254", "http://172.31.255.254", true],
		["http://192.168.5.7", "http://192.168.5.7", true],
		["http://[FC00:0010::15]:8080", "http://[fc00:10::15]:8080", true],
		["http://[fdff::5]", "http://[fdff::5]", true],
		["http://NAS", "http://nas", true],
		["http://nas.local:80/gateway/v1/", "http://nas.local/gateway/v1", true],
		["https://provider.example/v1", "https://provider.example/v1", false],
	]) assert.deepEqual(providerEndpoint(input, api), { baseUrl, lanHttp }, input);
	for (const host of [
		"1.1.1.1", "172.15.0.1", "172.32.0.1", "169.254.169.254", "100.64.10.1", "224.1.1.1", "0.0.0.0",
		"127.1", "192.168.01.2", "0xc0a80102", "3232235778", "192.168.1.2.", "%31%30.2.3.4", "nas..local",
		"[::]", "[fe80::1]", "[ff02::1]", "[2001:db8::1]", "[::ffff:192.168.1.2]", "[::ffff:c0a8:102]", "[fe80::1%25en0]",
	]) assert.throws(() => providerEndpoint(`http://${host}`, api), Error, host);
	assert.throws(() => providerEndpoint("http://nas/v1", "anthropic-messages"), /Remove the trailing/);
	assert.throws(() => providerEndpoint("http://key@nas/v1", api), /without credentials/);
	assert.throws(() => providerEndpoint("http://nas/v1?key=secret", api), /without credentials/);
});

test("LAN approval is bound to the exact canonical base, with no migration for HTTPS or numeric loopback", () => {
	const baseUrl = "http://nas.local:4000/gateway/v1";
	const profile = { baseUrl, api: "openai-completions" };
	assert.throws(() => authorizedProviderEndpoint(profile), /Approve this exact/);
	assert.throws(() => authorizedProviderEndpoint({ ...profile, lanHttpApprovedUrl: "http://nas.local:4000/v1" }), /Approve this exact/);
	assert.throws(() => authorizedProviderEndpoint({ ...profile, baseUrl: baseUrl + "/", lanHttpApprovedUrl: baseUrl }), /Approve this exact/);
	assert.equal(authorizedProviderEndpoint({ ...profile, lanHttpApprovedUrl: baseUrl }).baseUrl, baseUrl);
	assert.equal(authorizedProviderEndpoint({ ...profile, baseUrl: "http://127.0.0.1:4000/v1" }).lanHttp, false);
	assert.equal(authorizedProviderEndpoint({ ...profile, baseUrl: "https://provider.example/v1" }).lanHttp, false);
});

test("direct HTTP uses a compatible dispatcher even when Node still has its bundled fetch", async (t) => {
	const server = createServer((request, response) => response.end(request.headers.host));
	server.listen(0, "127.0.0.1");
	t.after(() => { server.closeAllConnections(); server.close(); });
	await once(server, "listening");
	const host = `127.0.0.1:${server.address().port}`;
	const baseUrl = `http://${host}/v1`;
	const endpoint = authorizedProviderEndpoint({ baseUrl, api: "openai-completions" });
	const input = new Request(baseUrl + "/models");
	const response = await fetchProvider(input, { redirect: "error" }, endpoint);
	assert.equal(await response.text(), host);
});
