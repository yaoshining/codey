// Answer the CLI's MCP/OAuth requests in memory and reject external sockets.
import { appendFileSync } from "node:fs";
import { Socket } from "node:net";

const serverUrl = "https://mcp.codey-fixture.invalid/mcp";
const issuer = "https://auth.codey-fixture.invalid";
const cimd = process.env.CODEY_MCP_SERVER_KIND === "cimd-only";
const log = (event) => appendFileSync(process.env.CODEY_MCP_LOG, `${JSON.stringify(event)}\n`);

const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
	// node:http passes normalized arguments as an array; direct calls use options.
	const normalized = Array.isArray(args[0]) ? args[0] : args;
	const options = normalized[0];
	const hostname = options?.host ?? options?.hostname;
	if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
		appendFileSync(process.env.CODEY_MCP_EXTERNAL_ATTEMPTS, `${String(hostname)}\n`);
		throw new Error("External sockets are disabled in Codey MCP OAuth tests");
	}
	return originalConnect.apply(this, args);
};

globalThis.fetch = async (input, init = {}) => {
	const url = new URL(String(input));
	log({ type: "fetch", url: url.href, method: init.method ?? "GET" });
	if (url.href === "https://mcp.codey-fixture.invalid/.well-known/oauth-protected-resource/mcp") {
		return Response.json({ resource: serverUrl, authorization_servers: [issuer] });
	}
	if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
		return Response.json({
			issuer,
			authorization_endpoint: `${issuer}/authorize`,
			token_endpoint: `${issuer}/token`,
			response_types_supported: ["code"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			authorization_response_iss_parameter_supported: true,
			...(cimd ? { client_id_metadata_document_supported: true } : { registration_endpoint: `${issuer}/register` }),
		});
	}
	if (url.href === `${issuer}/register` && !cimd) {
		const metadata = JSON.parse(init.body);
		log({ type: "registration", metadata });
		return Response.json({ ...metadata, client_id: "codey-fixture-registered-client" }, { status: 201 });
	}
	if (url.href === `${issuer}/token`) {
		const params = new URLSearchParams(init.body);
		log({ type: "token", clientId: params.get("client_id"), grantType: params.get("grant_type") });
		return Response.json({ access_token: "codey-fixture-access-token", token_type: "Bearer" });
	}
	if (url.href === serverUrl) {
		if (new Headers(init.headers).get("authorization") !== "Bearer codey-fixture-access-token") {
			return new Response("Fixture sign-in required", {
				status: 401,
				headers: {
					"www-authenticate":
						'Bearer resource_metadata="https://mcp.codey-fixture.invalid/.well-known/oauth-protected-resource/mcp"',
				},
			});
		}
		if (init.method === "GET") return new Response(null, { status: 405 });
		if (init.method === "DELETE") return new Response(null, { status: 204 });
		const message = JSON.parse(init.body);
		if (message.method === "initialize") {
			return Response.json({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: message.params.protocolVersion,
					serverInfo: { name: "codey-oauth-fixture", version: "1.0.0" },
					capabilities: { tools: {} },
				},
			});
		}
		if (message.method === "tools/list") {
			return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
		}
		if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
	}
	log({ type: "unmocked", url: url.href });
	throw new Error(`Unmocked request is forbidden in Codey MCP OAuth tests: ${url.href}`);
};
