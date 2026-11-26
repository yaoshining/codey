// Reuse Pi's protocol adapters while binding authentication to the configured request URL.
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { THINKING_LEVEL_OPTIONS } from "../../packages/coding-agent/src/core/defaults.ts";
import { authorizedProviderEndpoint, fetchProvider } from "./provider-endpoint.mjs";

export const protocols = new Map([
	["openai-completions", { label: "OpenAI Chat Completions", inference: "/chat/completions", catalog: "/models", create: openAICompletionsApi }],
	["openai-responses", { label: "OpenAI Responses", inference: "/responses", catalog: "/models", create: openAIResponsesApi }],
	["anthropic-messages", { label: "Anthropic Messages", inference: "/v1/messages", catalog: "/v1/models", create: anthropicMessagesApi }],
]);

export function supportedEffortValues(api) {
	if (api === "openai-responses") return THINKING_LEVEL_OPTIONS.filter((level) => level !== "off");
	if (api === "openai-completions") return ["low", "medium", "high"];
	return [];
}

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
	const models = profile.models.map((id) => {
		const levels = Object.hasOwn(profile.reasoningLevels ?? {}, id) ? profile.reasoningLevels[id] : undefined;
		const thinkingLevelMap = levels && Object.fromEntries(
			THINKING_LEVEL_OPTIONS.filter((level) => level !== "off").map((level) => [level, levels.includes(level) ? level : null]),
		);
		return {
			api: profile.api, provider: profile.id, id, name: displayName === profile.id ? id : `${displayName}/${id}`,
			// Pi RPC serializes these descriptors directly. Supply the URL only to the private adapter.
			baseUrl: "", reasoning: Boolean(levels), ...(levels ? { thinkingLevelMap } : {}),
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32000, maxTokens: 4096,
		};
	});
	function requestModel(model) {
		const privateModel = { ...model, baseUrl: profile.baseUrl };
		if (model.reasoning) {
			// In the UI, off means use the gateway default. Pi's Responses adapter
			// would otherwise send "none". Only the adapter's copy suppresses that field.
			privateModel.thinkingLevelMap = { ...model.thinkingLevelMap, off: null };
			if (profile.api === "openai-completions") {
				privateModel.compat = { ...model.compat, thinkingFormat: "openai", supportsReasoningEffort: true };
			}
		}
		return privateModel;
	}
	// The SDKs require a local placeholder before producing a request. It never reaches
	// the network: the guarded fetch replaces all authentication headers at dispatch.
	const requestOptions = (options) => ({ ...options, apiKey: "codey-managed-credential", fetch });
	return {
		// Pi uses Provider.name to resolve authentication commands. A Codey display alias must not shadow another ID.
		id: profile.id, name: displayName.toLowerCase() === profile.id ? displayName : profile.id, baseUrl: profile.baseUrl,
		auth: { apiKey: { name: source, check: async () => ({ type: "api_key", source }), resolve: async () => ({ auth: {}, source }) } },
		getModels: () => models,
		stream: (model, context, options) => streams.stream(requestModel(model), context, requestOptions(options)),
		streamSimple: (model, context, options) => streams.streamSimple(requestModel(model), context, requestOptions(options)),
	};
}

const maxCatalogPageBytes = 16 * 1024 * 1024;
const maxCatalogBatchBytes = 48 * 1024 * 1024;
const maxCatalogBatchPages = 64;
const maxCatalogPages = 1024;
const maxCatalogIds = 50_000;

async function boundedJson(response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("The response had no model catalog.");
	let size = 0;
	const chunks = [];
	try {
		for (;;) {
			const { done, value } = await reader.read().catch(() => {
				throw Object.assign(new Error("The catalog response was interrupted."), { code: "CODEY_CATALOG_INTERRUPTED" });
			});
			if (done) break;
			size += value.length;
			if (size > maxCatalogPageBytes) throw new Error("A model catalog page exceeded the 16 MiB safety limit.");
			chunks.push(value);
		}
		try { return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")), size }; } catch { throw new Error("The endpoint did not return a JSON model catalog."); }
	} finally {
		await reader.cancel().catch(() => {});
	}
}

export function validModelId(value) {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

export async function discoverModels(profile, previous) {
	const policy = authorizedProviderEndpoint(profile);
	const endpoint = new URL(policy.baseUrl + protocols.get(profile.api).catalog);
	const { ids, seen } = previous ?? { ids: new Set(), seen: new Set() };
	const signal = AbortSignal.timeout(25_000);
	let page = previous?.page ?? endpoint;
	let remaining = maxCatalogBatchPages;
	let batchBytes = 0;
	let retryable = false;
	const partial = (reason, resume) => ({
		ids: [...ids], reason, partial: true,
		continuation: resume ? { ids, seen, page } : undefined,
	});
	try {
		while (page) {
			retryable = false;
			if (page.origin !== endpoint.origin || page.pathname !== endpoint.pathname || page.username || page.password || page.hash) {
				throw new Error("Catalog pagination attempted to leave the approved endpoint.");
			}
			if (page.href.length > 8192) throw new Error("The next model catalog page URL is too long.");
			if (seen.has(page.href)) throw new Error("Catalog pagination repeated a page.");
			if (seen.size >= maxCatalogPages) return partial("The catalog exceeded the 1,024-page safety limit.", false);
			if (remaining-- === 0 || batchBytes >= maxCatalogBatchBytes) return partial("More catalog pages are available.", true);
			let response;
			try { response = await fetchProvider(page, { headers: headersFor(profile), redirect: "manual", signal }, policy); } catch (error) {
				if (error.code === "CODEY_LAN_HTTP_ADDRESS") throw error;
				retryable = true;
				throw new Error("Model discovery could not connect. Check the URL, network and TLS certificate.");
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				if (response.status >= 300 && response.status < 400) throw new Error("The catalog redirected. Use the final Base URL.");
				if (response.status === 401 || response.status === 403) throw new Error(`Catalog authentication was rejected (HTTP ${response.status}).`);
				if ([404, 405, 501].includes(response.status)) throw new Error(`The endpoint does not expose this model catalog (HTTP ${response.status}).`);
				retryable = response.status === 408 || response.status === 429 || response.status >= 500;
				throw new Error(`Model discovery returned HTTP ${response.status}.`);
			}
			const { data, size } = await boundedJson(response);
			batchBytes += size;
			if (!Array.isArray(data?.data)) throw new Error("The endpoint did not return a supported model catalog.");
			for (const entry of data.data) {
				const id = entry?.id;
				if (!validModelId(id) || (profile.key && id.includes(profile.key)) || ids.has(id)) continue;
				if (ids.size === maxCatalogIds) return partial("The catalog exceeded the 50,000-ID safety limit.", false);
				ids.add(id);
			}
			seen.add(page.href);
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
		return partial(signal.aborted ? "Model discovery timed out." : error.name === "Error" ? error.message : "The model catalog response could not be read.",
			signal.aborted || retryable || error.code === "CODEY_CATALOG_INTERRUPTED");
	}
}
