// Connect one parent-approved stdio channel to one HTTPS MCP endpoint.
import { isJsonRpcRequest, StreamableHttpTransport, SUPPORTED_PROTOCOL_VERSIONS } from "@earendil-works/pi-mcp";
import { Agent, fetch } from "undici";
import { JsonRpcLineReader } from "../../packages/mcp/src/transports/lines.ts";
import { bridgeOAuthAuth } from "./mcp-bridge-oauth.mjs";
import { bridgeTlsOptions } from "./mcp-bridge-tls.mjs";

function diagnostic(error) {
	for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
		if (cause.code === "ERR_TLS_CERT_ALTNAME_INVALID") return "MCP bridge TLS identity mismatch. The URL hostname or IP must match the certificate SAN.";
		if (cause.code === "CERT_HAS_EXPIRED" || cause.code === "CERT_NOT_YET_VALID") return "MCP bridge TLS certificate is expired or not yet valid.";
		if (["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(cause.code)) {
			return "MCP bridge TLS certificate is untrusted. Check the server's chain or configure a verified public PEM for this bridge.";
		}
		if (cause.status === 401 || cause.message === "MCP bridge sign-in required.") return "MCP bridge authentication failed. Run /mcp bridge login or verify the configured Bearer token.";
		if (Number.isInteger(cause.status) && cause.status >= 400 && cause.status <= 599) return `MCP bridge endpoint returned HTTP ${cause.status}.`;
	}
	return "MCP bridge could not reach its configured endpoint.";
}

async function run() {
	const url = new URL(process.env.CODEY_MCP_BRIDGE_URL);
	const ca = process.env.CODEY_MCP_BRIDGE_CA;
	const token = process.env.CODEY_MCP_BRIDGE_TOKEN;
	const oauthFile = process.env.CODEY_MCP_BRIDGE_OAUTH_FILE;
	delete process.env.CODEY_MCP_BRIDGE_TOKEN;
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Missing bridge configuration");
	const dispatcher = new Agent({ connect: bridgeTlsOptions(ca), headersTimeout: 30_000 });
	const secrets = new Set(token ? [token] : []);
	const authProvider = !token && oauthFile ? bridgeOAuthAuth(url, ca, oauthFile, (secret) => secrets.add(secret)) : undefined;
	const remote = new StreamableHttpTransport({
		url, headers: token ? { Authorization: `Bearer ${token}` } : undefined, authProvider,
		fetch(input, init) {
			if (new URL(input).href !== url.href) throw new Error("The MCP bridge destination changed");
			return fetch(url, { ...init, dispatcher, redirect: "error" });
		},
	});
	let closing;
	let initializeId;
	let pending = 0;
	function close() {
		closing ??= Promise.resolve().then(async () => {
			process.stdin.destroy();
			try { await remote.close(); } finally { await Promise.all([dispatcher.destroy(), authProvider?.settled()]); }
		});
		return closing;
	}
	function fail(message) {
		if (closing) return;
		process.exitCode = 1;
		process.stderr.write(`${message}\n`);
		void close();
	}
	function send(message) {
		if (closing) return;
		const line = JSON.stringify(message, (key, value) => {
			if (typeof value !== "string" || ["jsonrpc", "method", "id", "protocolVersion"].includes(key)) return value;
			for (const secret of secrets) value = value.replaceAll(secret, "[redacted]");
			return value;
		});
		process.stdout.write(`${line}\n`);
	}
	remote.onMessage((message) => {
		if (message.method === "notifications/message") return;
		if (initializeId !== undefined && message.id === initializeId && SUPPORTED_PROTOCOL_VERSIONS.includes(message.result?.protocolVersion)) {
			remote.setProtocolVersion(message.result.protocolVersion);
			initializeId = undefined;
		}
		send(message);
	});
	remote.onError(() => fail("MCP bridge remote stream failed."));
	remote.onClose(() => void close());
	const input = new JsonRpcLineReader({
		onError: () => fail("MCP bridge received invalid stdio input."),
		onMessage(message) {
			if (closing) return;
			if (pending >= 32) return fail("MCP bridge request limit reached.");
			pending++;
			if (isJsonRpcRequest(message) && message.method === "initialize") initializeId = message.id;
			void remote.send(message).catch((error) => {
				const status = diagnostic(error);
				if (isJsonRpcRequest(message)) send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: status } });
				else fail(status);
			}).finally(() => pending--);
		},
	});
	await remote.start();
	process.stdout.on("error", () => void close());
	process.stdin.on("data", (bytes) => input.readStdout(bytes));
	process.stdin.on("end", () => { input.end(); void close(); });
	process.stdin.on("error", () => void close());
	process.once("SIGTERM", () => void close());
}

try { await run(); } catch {
	process.stderr.write("Could not start the configured Codey MCP bridge.\n");
	process.exitCode = 1;
}
