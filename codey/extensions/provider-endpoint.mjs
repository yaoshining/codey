// Bind plaintext provider traffic to an approved URL and private connection addresses.
import dns from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";

function localAddress(address) {
	const family = isIP(address);
	if (family === 4) {
		const [first, second] = address.split(".").map(Number);
		return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168);
	}
	if (family !== 6 || /[.%]/.test(address)) return false;
	const normalized = new URL(`http://[${address}]`).hostname;
	return normalized === "[::1]" || /^\[f[cd][0-9a-f]{2}:/i.test(normalized);
}

export function providerEndpoint(input, api) {
	let url;
	try { url = new URL(input); } catch { throw new Error("Enter an absolute API Base URL."); }
	if (!/^https?:\/\//i.test(input) || url.username || url.password || input.length > 2048 || /[?#\\\p{Cc}\p{Cf}\s]/u.test(input)) {
		throw new Error("Use an HTTP or HTTPS Base URL without credentials, query or fragment.");
	}
	let lanHttp = false;
	if (url.protocol === "http:") {
		const host = /^http:\/\/(\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::[1-9][0-9]{0,4})?(?:\/|$)/i.exec(input)?.[1];
		const literal = url.hostname.replace(/^\[|\]$/g, "");
		const family = isIP(literal);
		const validHost = family === 4 ? host === literal
			: family === 6 ? host?.startsWith("[")
				: host?.toLowerCase() === url.hostname && host.length <= 253 &&
					host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
		if (!validHost || (family && !localAddress(literal))) {
			throw new Error("Use HTTPS for public endpoints. HTTP requires a normal LAN hostname or a private or loopback IP address in standard notation.");
		}
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

const directLan = new Agent({
	connect: {
		lookup(hostname, options, callback) {
			// net.connect dials only the returned numerics and retains the original HTTP Host.
			void dns.promises.lookup(hostname, { all: true }).then((addresses) => {
				if (!addresses.length || addresses.some(({ address, family }) => family !== isIP(address) || !localAddress(address))) {
					throw Object.assign(new Error("The HTTP hostname did not resolve exclusively to private or loopback addresses."), {
						code: "CODEY_LAN_HTTP_ADDRESS",
					});
				}
				return addresses;
			}).then((addresses) => {
				if (options.all) callback(null, addresses);
				else callback(null, addresses[0].address, addresses[0].family);
			}, callback);
		},
	},
});

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
