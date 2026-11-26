// Bind plaintext provider traffic to an approved URL and private connection addresses.
import { fetch } from "undici";
import { createLanHttpDispatcher, validateLanHttpUrl } from "./lan-http.mjs";

export function providerEndpoint(input, api) {
	let url;
	try { url = new URL(input); } catch { throw new Error("Enter an absolute API Base URL."); }
	if (!/^https?:\/\//i.test(input) || url.username || url.password || input.length > 2048 || /[?#\\\p{Cc}\p{Cf}\s]/u.test(input)) {
		throw new Error("Use an HTTP or HTTPS Base URL without credentials, query or fragment.");
	}
	let lanHttp = false;
	if (url.protocol === "http:") {
		validateLanHttpUrl(input);
		lanHttp = !["127.0.0.1", "[::1]"].includes(url.hostname);
	}
	const path = url.pathname.replace(/\/+$/, "");
	if (api === "anthropic-messages" && path.endsWith("/v1")) throw new Error("Remove the trailing /v1 from the Anthropic Base URL.");
	return { baseUrl: url.origin + path, lanHttp };
}

export function authorizedProviderEndpoint(profile) {
	const endpoint = providerEndpoint(profile.baseUrl, profile.api);
	if (endpoint.lanHttp && (profile.baseUrl !== endpoint.baseUrl || profile.lanHttpApprovedUrl !== endpoint.baseUrl)) {
		throw new Error("Approve this exact LAN HTTP Base URL in /provider before connecting.");
	}
	return endpoint;
}

const directLan = createLanHttpDispatcher();

export async function fetchProvider(input, init, endpoint) {
	if (!endpoint.baseUrl.startsWith("http:")) return globalThis.fetch(input, init);
	const request = input instanceof Request ? input : undefined;
	const headers = new Headers(init.headers ?? request?.headers);
	headers.delete("host");
	try {
		// Keep fetch and the dispatcher on the same Undici version even in the sandbox host.
		return await fetch(request?.url ?? input, {
			method: request?.method, body: request?.body, signal: request?.signal, ...init,
			headers, dispatcher: directLan, duplex: "half",
		});
	} catch (error) {
		if (error.cause?.code === "CODEY_LAN_HTTP_ADDRESS") throw error.cause;
		throw error;
	}
}
