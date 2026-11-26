// Use Pi's direct MCP transport with unauthenticated, LAN-only HTTP requests.
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { fetch } from "undici";
import { createLanHttpDispatcher, validateLanHttpUrl } from "./lan-http.mjs";

const protocolHeaders = new Set(["accept", "content-type", "last-event-id", "mcp-session-id", "mcp-protocol-version"]);

export function createPlainHttpMcpTransport(endpoint, probe = false) {
	const url = validateLanHttpUrl(endpoint);
	if (url.href !== endpoint) throw new Error("The saved HTTP MCP address must match the approved URL.");
	const dispatcher = createLanHttpDispatcher();
	const transport = new StreamableHttpTransport({
		url: endpoint,
		async fetch(input, init) {
			if (new URL(input).href !== endpoint) throw new Error("The MCP request left the approved HTTP endpoint.");
			const headers = new Headers();
			for (const [name, value] of new Headers(init.headers)) {
				if (protocolHeaders.has(name)) headers.set(name, value);
			}
			const signal = probe ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : init.signal;
			let response;
			try {
				response = await fetch(url, { ...init, headers, signal, dispatcher, redirect: "manual", credentials: "omit" });
			} catch (error) {
				if (error.cause?.code === "CODEY_LAN_HTTP_ADDRESS") throw error.cause;
				throw error;
			}
			if (response.status === 401 || response.status === 403) {
				await response.body?.cancel().catch(() => {});
				throw new Error("The MCP endpoint required authentication or denied access. Use HTTPS for authenticated MCP.");
			}
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel().catch(() => {});
				throw new Error("HTTP MCP redirects are disabled. Add the final LAN endpoint explicitly.");
			}
			return response;
		},
	});
	const close = transport.close.bind(transport);
	transport.close = async () => {
		try { await close(); } finally { await dispatcher.destroy(); }
	};
	return transport;
}
