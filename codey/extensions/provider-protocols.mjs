// Reuse Pi's protocol adapters while binding authentication to the configured request URL.
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { authorizedProviderEndpoint, fetchProvider } from "./provider-endpoint.mjs";

export const protocols = new Map([
	["openai-completions", { label: "OpenAI Chat Completions", inference: "/chat/completions", catalog: "/models", create: openAICompletionsApi }],
	["openai-responses", { label: "OpenAI Responses", inference: "/responses", catalog: "/models", create: openAIResponsesApi }],
	["anthropic-messages", { label: "Anthropic Messages", inference: "/v1/messages", catalog: "/v1/models", create: anthropicMessagesApi }],
]);

// A future OAuth adapter must own token resolution and refresh for its provider.
export const authentication = new Map([
	["key", { label: "API Key", token: (profile) => profile.key }],
	["none", { label: "No authentication", token: () => undefined }],
]);

function headersFor(profile, initial) {
	const headers = new Headers(initial);
	for (const name of ["Authorization", "X-API-Key", "API-Key"]) headers.delete(name);
	const key = authentication.get(profile.auth).token(profile);
	if (profile.api === "anthropic-messages") {
		if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
		if (key) headers.set("x-api-key", key);
	} else if (key) headers.set("Authorization", `Bearer ${key}`);
	return headers;
}

function withoutEchoedKey(response, key) {
	if (!key) return response;
	const escaped = JSON.stringify(key).slice(1, -1);
	const candidates = [...new Set([escaped, key])].sort((a, b) => b.length - a.length);
	const matches = new RegExp(candidates.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
	const replacement = "[redacted]";
	const headers = new Headers(response.headers);
	for (const [name, value] of headers) if (value.includes(key)) headers.set(name, value.replaceAll(key, replacement));
	headers.delete("content-length");
	headers.delete("content-encoding");
	let pending = "";
	const emit = (controller, end) => {
		let safe = pending.length;
		if (!end) for (const candidate of candidates) {
			for (let length = Math.min(candidate.length - 1, pending.length); length > pending.length - safe; length--) {
				if (!candidate.startsWith(pending.slice(-length))) continue;
				safe = pending.length - length;
				break;
			}
		}
		let cursor = 0;
		let output = "";
		for (const match of pending.matchAll(matches)) {
			if (match.index >= safe) break;
			output += pending.slice(cursor, match.index) + replacement;
			cursor = match.index + match[0].length;
		}
		const consumed = Math.max(safe, cursor);
		output += pending.slice(cursor, consumed);
		pending = pending.slice(consumed);
		if (output) controller.enqueue(output);
	};
	const body = response.body?.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream({
		transform(chunk, controller) { pending += chunk; emit(controller, false); },
		flush(controller) { emit(controller, true); },
	})).pipeThrough(new TextEncoderStream());
	return new Response(body, { status: response.status, statusText: response.statusText.replaceAll(key, replacement), headers });
}

export function providerFromProfile(profile) {
	const endpoint = authorizedProviderEndpoint(profile);
	const adapter = protocols.get(profile.api);
	const streams = adapter.create();
	const expected = new URL(profile.baseUrl + adapter.inference);
	const fetch = async (input, init = {}) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password) {
			throw new Error("The custom provider's request destination changed.");
		}
		const response = await fetchProvider(input, { ...init, redirect: "error", headers: headersFor(profile, init.headers ?? (input instanceof Request ? input.headers : undefined)) }, endpoint);
		return withoutEchoedKey(response, authentication.get(profile.auth).token(profile));
	};
	const source = profile.auth === "none" ? "no authentication (Codey /provider)" : "Codey /provider";
	const displayName = profile.displayName ?? profile.id;
	// Pi's model selector can display a model label alongside the canonical provider ID.
	const models = profile.models.map((id) => ({
		api: profile.api, provider: profile.id, id, name: displayName === profile.id ? id : `${displayName}/${id}`, baseUrl: profile.baseUrl,
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000, maxTokens: 4096,
	}));
	// The SDKs require a local placeholder before producing a request. It never reaches
	// the network: the guarded fetch replaces all authentication headers at dispatch.
	const requestOptions = (options) => ({ ...options, apiKey: "codey-managed-credential", fetch });
	return {
		id: profile.id, name: displayName, baseUrl: profile.baseUrl,
		auth: { apiKey: { name: source, check: async () => ({ type: "api_key", source }), resolve: async () => ({ auth: {}, source }) } },
		getModels: () => models,
		stream: (model, context, options) => streams.stream(model, context, requestOptions(options)),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, requestOptions(options)),
	};
}

async function boundedJson(response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("The response had no model catalog.");
	let size = 0;
	const chunks = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 512 * 1024) throw new Error("A model catalog page exceeded 512 KiB.");
			chunks.push(value);
		}
		try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("The endpoint did not return a JSON model catalog."); }
	} finally {
		await reader.cancel().catch(() => {});
	}
}

export function validModelId(value) {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

export async function discoverModels(profile) {
	const policy = authorizedProviderEndpoint(profile);
	const endpoint = new URL(policy.baseUrl + protocols.get(profile.api).catalog);
	const seen = new Set();
	const ids = new Set();
	const signal = AbortSignal.timeout(8_000);
	let page = endpoint;
	try {
		while (page) {
			if (page.origin !== endpoint.origin || page.pathname !== endpoint.pathname || page.username || page.password || page.hash) {
				throw new Error("Catalog pagination attempted to leave the approved endpoint.");
			}
			if (seen.has(page.href)) throw new Error("Catalog pagination repeated a page.");
			if (seen.size >= 10) throw new Error("Stopped after 10 model catalog pages.");
			seen.add(page.href);
			let response;
			try { response = await fetchProvider(page, { headers: headersFor(profile), redirect: "manual", signal }, policy); } catch (error) {
				if (error.code === "CODEY_LAN_HTTP_ADDRESS") throw error;
				throw new Error(signal.aborted ? "Model discovery timed out." : "Model discovery could not connect. Check the URL, network and TLS certificate.");
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				if (response.status >= 300 && response.status < 400) throw new Error("The catalog redirected. Use the final Base URL.");
				if (response.status === 401 || response.status === 403) throw new Error(`Catalog authentication was rejected (HTTP ${response.status}).`);
				if ([404, 405, 501].includes(response.status)) throw new Error(`The endpoint does not expose this model catalog (HTTP ${response.status}).`);
				throw new Error(`Model discovery returned HTTP ${response.status}.`);
			}
			const data = await boundedJson(response);
			if (!Array.isArray(data?.data)) throw new Error("The endpoint did not return a supported model catalog.");
			for (const entry of data.data) {
				if (validModelId(entry?.id)) ids.add(entry.id);
				if (ids.size >= 500) throw new Error("Stopped after 500 distinct model IDs.");
			}
			const next = data.next ?? /<([^>]+)>;\s*rel="?next"?(?:[,;\s]|$)/i.exec(response.headers.get("link") ?? "")?.[1];
			if (typeof next === "string" && next) {
				try { page = new URL(next, page); } catch { throw new Error("The next model catalog page URL is invalid."); }
			} else if (data.has_more === true) {
				const cursor = data.last_id ?? data.data.at(-1)?.id;
				if (!validModelId(cursor)) throw new Error("The catalog did not supply a usable next-page cursor.");
				page = new URL(page);
				page.searchParams.set(profile.api === "anthropic-messages" ? "after_id" : "after", cursor);
			} else page = undefined;
		}
		return { ids: [...ids], reason: ids.size ? undefined : "The catalog returned no model IDs." };
	} catch (error) {
		return { ids: [...ids], reason: signal.aborted ? "Model discovery timed out." : error.name === "Error" ? error.message : "The model catalog response could not be read." };
	}
}
