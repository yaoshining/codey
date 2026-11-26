// Scope the pinned MCP OAuth SDK to a user-approved resource, issuer and credentials endpoints.
import { authorizeMcp, discoverAuthorizationServerMetadata, discoverProtectedResourceMetadata, McpOAuthProvider,
	MemoryOAuthStateStore, OAuthCallbackServer, parseWwwAuthenticate, waitForLoopbackSignIn } from "@earendil-works/pi-mcp/oauth";
import { Agent, fetch } from "undici";
import { openBrowser } from "../../packages/coding-agent/src/utils/open-browser.ts";
import { bridgeOAuthStore, oauthStatePath } from "./mcp-bridge-oauth-store.mjs";
import { bridgeTlsOptions } from "./mcp-bridge-tls.mjs";

function httpsUrl(value) {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href.length > 2048) throw new Error("OAuth requires valid HTTPS endpoints.");
	return url;
}

function scopedNetwork(resource, ca) {
	const local = new Agent({ connect: bridgeTlsOptions(ca) });
	const publicTrust = new Agent({ connect: bridgeTlsOptions() });
	return {
		async request(input, init) {
			const url = httpsUrl(input);
			const timeout = AbortSignal.timeout(15_000);
			const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
			const response = await fetch(url, { ...init, signal, redirect: "error", dispatcher: url.origin === resource.origin ? local : publicTrust });
			if (!response.body) return response;
			let bytes = 0;
			const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
				bytes += chunk.byteLength;
				if (bytes > 128 * 1024) throw new Error("OAuth response exceeded the size limit.");
				controller.enqueue(chunk);
			} }));
			return new Response(body, { status: response.status, headers: response.headers });
		},
		close: async () => { await Promise.all([local.destroy(), publicTrust.destroy()]); },
	};
}

function bindingFor(resource, discovery) {
	const { authorizationServerUrl, authorizationServerMetadata: metadata, resourceMetadata } = discovery;
	const issuer = httpsUrl(authorizationServerUrl);
	if (!metadata || httpsUrl(metadata.issuer).href !== issuer.href || httpsUrl(resourceMetadata?.resource).href !== resource.href) {
		throw new Error("OAuth metadata did not match the configured MCP resource and issuer.");
	}
	const endpoints = [metadata.authorization_endpoint, metadata.registration_endpoint, metadata.token_endpoint];
	if (!endpoints.every((entry) => typeof entry === "string")) throw new Error("The OAuth issuer must advertise authorization, dynamic registration and token endpoints.");
	const [browser, registration, token] = endpoints.map(httpsUrl);
	return { issuer, browser, registration, token };
}

function preparedProvider(resource, store, redirectUrl, onRedirect = () => {}) {
	return new McpOAuthProvider({ serverUrl: resource, redirectUrl, store, onRedirect,
		clientMetadata: { client_name: "Codey MCP bridge", token_endpoint_auth_method: "none" } });
}

function authorizeFetch(network, binding, allowed) {
	return (input, init) => {
		const url = httpsUrl(input);
		if (init?.method !== "POST" || !allowed.some((role) => binding[role].href === url.href)) {
			throw new Error("OAuth attempted a request outside the approved endpoints.");
		}
		return network.request(url, init);
	};
}

export async function loginBridge(bridge, ui, isCurrent) {
	const resource = httpsUrl(bridge.url);
	const network = scopedNetwork(resource, bridge.pem);
	const deadline = AbortSignal.timeout(180_000);
	async function allow(title, details) {
		return await ui.select(`${title}\n${details}`, ["Cancel", "Allow"], { signal: deadline, blockedKind: "permission" }) === "Allow";
	}
	try {
		const challengeResponse = await network.request(resource, { headers: { Accept: "application/json, text/event-stream" }, signal: deadline });
		const challenge = challengeResponse.status === 401 ? parseWwwAuthenticate(challengeResponse.headers.get("www-authenticate")) : {};
		await challengeResponse.body?.cancel();
		const metadataUrl = challenge.resourceMetadataUrl && httpsUrl(challenge.resourceMetadataUrl);
		if (metadataUrl && metadataUrl.origin !== resource.origin &&
			!await allow("Read protected-resource metadata from another HTTPS origin?", `${metadataUrl.origin}\nMetadata only. Codey sends no OAuth credentials.`)) return false;
		const resourceMetadata = await discoverProtectedResourceMetadata(resource, {
			resourceMetadataUrl: metadataUrl, signal: deadline,
			fetch: (url, init) => {
				if (httpsUrl(url).origin !== (metadataUrl?.origin ?? resource.origin)) throw new Error("Protected-resource metadata left the approved origin.");
				return network.request(url, init);
			},
		});
		if (httpsUrl(resourceMetadata.resource).href !== resource.href) throw new Error("The OAuth resource does not match this MCP endpoint.");
		const issuers = [...new Set((resourceMetadata.authorization_servers ?? []).map((url) => httpsUrl(url).href))];
		if (!issuers.length || issuers.length > 12) throw new Error("The MCP metadata did not advertise a usable list of OAuth issuers.");
		let [issuer] = issuers;
		if (issuers.length > 1) {
			issuer = await ui.select("Choose the OAuth issuer and allow reading its metadata", ["Cancel", ...issuers], { signal: deadline, blockedKind: "permission" });
			if (!issuer || issuer === "Cancel") return false;
		} else if (httpsUrl(issuer).origin !== resource.origin &&
			!await allow("Read OAuth issuer metadata from another HTTPS origin?", `${issuer}\nMetadata only. Codey sends no OAuth credentials.`)) return false;
		const authorizationServerMetadata = await discoverAuthorizationServerMetadata(issuer, {
			signal: deadline,
			fetch: (url, init) => {
				if (httpsUrl(url).origin !== new URL(issuer).origin) throw new Error("OAuth metadata left the approved issuer.");
				return network.request(url, init);
			},
		});
		const discovery = { authorizationServerUrl: issuer, authorizationServerMetadata, resourceMetadata };
		const binding = bindingFor(resource, discovery);
		const scope = challenge.scope || resourceMetadata.scopes_supported?.join(" ");
		const destinations = [
			["Browser sign-in page", binding.browser],
			["Codey client registration", binding.registration],
			["Codey token exchange and refresh", binding.token],
		];
		const external = destinations.filter(([, url]) => url.origin !== resource.origin);
		if (external.length && !await allow("Allow these cross-origin OAuth destinations?", [
			`MCP resource: ${resource.href}`,
			...external.map(([role, { origin, pathname }]) => `${role}: ${origin}${pathname}`),
			`Scope: ${scope?.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 240) || "issuer defaults"}`,
		].join("\n"))) return false;
		deadline.throwIfAborted();
		const callback = await OAuthCallbackServer.listen({ host: "127.0.0.1", path: "/callback", timeoutMs: 180_000,
			renderPage: ({ ok }) => ok ? "Authorization received. Return to Codey." : "Authorization was declined or invalid. Return to Codey." });
		try {
			const memory = new MemoryOAuthStateStore();
			await memory.save({ serverUrl: resource.href, discovery });
			let browserUrl;
			const provider = preparedProvider(resource, memory, callback.redirectUrl, (url) => { browserUrl = url; });
			const options = { serverUrl: resource, scope, fetch: authorizeFetch(network, binding, ["registration", "token"]), signal: deadline };
			await authorizeMcp(provider, { ...options, skipRefresh: true });
			if (!browserUrl || browserUrl.origin !== binding.browser.origin || browserUrl.pathname !== binding.browser.pathname ||
				browserUrl.searchParams.get("redirect_uri") !== callback.redirectUrl) throw new Error("The OAuth browser destination changed.");
			const authorization = { kind: "redirect", authorizationUrl: browserUrl.href, redirectUrl: callback.redirectUrl,
				state: await provider.state(), scope };
			const response = await waitForLoopbackSignIn({ callback, authorization, signal: deadline,
				async promptForRedirectUrl(signal) {
					openBrowser(browserUrl.href);
					await ui.select(`Waiting for browser approval at ${binding.browser.origin}`, ["Cancel sign-in"], { signal, blockedKind: "auth" });
					return undefined;
				},
			});
			await authorizeMcp(provider, { ...options, fetch: authorizeFetch(network, binding, ["token"]),
				authorizationCode: response.code, iss: response.iss, authorizationRedirectUrl: callback.redirectUrl });
			const state = await memory.load();
			validAccessToken(state.tokens);
			delete state.codeVerifier;
			delete state.oauthState;
			delete state.tokens.id_token;
			const store = bridgeOAuthStore(oauthStatePath(bridge));
			await store.locked(() => {
				if (!isCurrent()) throw new Error("This bridge changed during sign-in.");
				store.save(state);
			});
			return true;
		} finally { await callback.close(); }
	} finally { await network.close(); }
}

function validAccessToken(tokens) {
	const token = tokens?.access_token;
	if (tokens?.token_type?.toLowerCase() !== "bearer" || typeof token !== "string" || token.length > 8192 || !/^[a-z0-9._~+/-]+=*$/i.test(token)) throw new Error("Invalid MCP bridge Bearer token.");
	return token;
}

export function bridgeOAuthAuth(resource, ca, file, rememberToken) {
	const store = bridgeOAuthStore(file);
	let refreshing;
	function refresh(rejected) {
		refreshing ??= store.locked(async () => {
			const state = store.load();
			if (state?.serverUrl !== resource.href || !state.tokens?.refresh_token) throw new Error("MCP bridge sign-in required.");
			if (state.tokens.access_token !== rejected) return;
			const binding = bindingFor(resource, state.discovery);
			const network = scopedNetwork(resource, ca);
			try {
				const memory = new MemoryOAuthStateStore();
				await memory.save(state);
				const provider = preparedProvider(resource, memory, "http://127.0.0.1/callback");
				const result = await authorizeMcp(provider, { serverUrl: resource, refreshOnly: true, fetch: authorizeFetch(network, binding, ["token"]) });
				if (result !== "AUTHORIZED") throw new Error("MCP bridge sign-in required.");
				const updated = await memory.load();
			validAccessToken(updated.tokens);
			delete updated.tokens.id_token;
				store.save(updated);
			} finally { await network.close(); }
		}).finally(() => { refreshing = undefined; });
		return refreshing;
	}
	return {
		async token() {
			let state = store.load();
			if (!state) return undefined;
			if (state.serverUrl !== resource.href) throw new Error("OAuth grant does not match the MCP endpoint.");
			if (state.tokensExpireAt !== undefined && state.tokensExpireAt <= Date.now() + 15_000) {
				await refresh(state.tokens?.access_token);
				state = store.load();
			}
			const token = validAccessToken(state?.tokens);
			rememberToken(token);
			return token;
		},
		onUnauthorized({ token, response }) {
			if (!token || parseWwwAuthenticate(response.headers.get("www-authenticate")).error === "insufficient_scope") {
				throw new Error("MCP bridge sign-in required.");
			}
			return refresh(token);
		},
		settled: () => refreshing?.catch(() => {}) ?? Promise.resolve(),
	};
}
