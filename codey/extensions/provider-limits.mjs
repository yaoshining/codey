// Per-route limits from explicit metadata and user overrides.
export const limitFields = { contextWindow: "Context window", maxTokens: "Output limit" };
const defaults = { contextWindow: 32_000, maxTokens: 4_096 };
const sources = new Set(["Model catalog", "Anthropic model catalog", "Gateway model info"]);
const fields = Object.keys(limitFields);
const maxSupported = 10_000_000;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validLimit = (value) => Number.isSafeInteger(value) && value > 0 && value <= maxSupported;
export const validModelLimit = (value, api) => validLimit(value) && (api !== "openai-responses" || value >= 16);
const ownValue = (object, key) => Object.hasOwn(object ?? {}, key) ? object[key] : undefined;

export function readCatalogLimits(entry, api, info = false) {
	const meta = info ? entry?.model_info : entry;
	if (!record(meta)) return {};
	const source = info ? "Gateway model info" : "Model catalog";
	const candidates = [
		["contextWindow", meta.context_window, source],
		["contextWindow", meta.context_length, source],
		["maxTokens", meta.max_output_tokens, source],
	];
	if (!info && validLimit(meta.context_length)) {
		candidates.push(["maxTokens", meta.top_provider?.max_completion_tokens, source]);
	}
	if (!info && api === "anthropic-messages" && entry.type === "model") {
		candidates.push(["maxTokens", entry.max_tokens, "Anthropic model catalog"]);
	}
	const limits = {};
	for (const [field, value, reportedBy] of candidates) {
		if (validModelLimit(value, api) && (limits[field] === undefined || value < limits[field].value)) {
			limits[field] = { value, source: reportedBy };
		}
	}
	if (limits.contextWindow && limits.maxTokens?.value > limits.contextWindow.value) delete limits.maxTokens;
	return limits;
}

// Several deployments can share a single exact route. A missing field on any
// matching row leaves it unknown. Where all provide it, use the lowest ceiling.
export function commonModelLimits(left, right) {
	return Object.fromEntries(fields.flatMap((field) => {
		const a = left[field], b = right[field];
		return a && b ? [[field, a.value <= b.value ? a : b]] : [];
	}));
}

export function mergeReportedLimits(left = {}, right = {}) {
	return { ...left, ...right, ...commonModelLimits(left, right) };
}

export function modelLimitSettings(profile, model, settings = ownValue(profile.modelLimits, model)) {
	const limits = Object.fromEntries(fields.map((field) => {
		const override = settings?.manual?.[field];
		const detected = settings?.detected?.[field];
		return [field, validLimit(override) ? { value: override, source: "Manual" } :
			detected ?? { value: defaults[field], source: "Unknown · compatibility default" }];
	}));
	const output = limits.maxTokens;
	if (output.value > limits.contextWindow.value) {
		limits.maxTokens = { ...output, value: limits.contextWindow.value, capped: true };
	}
	return limits;
}

export function validateModelLimits(profile, settings = {}) {
	if (!record(settings)) throw new Error("Invalid model limits.");
	return Object.fromEntries(Object.entries(settings).map(([model, limits]) => {
		if (!profile.models.includes(model) || !record(limits)) throw new Error("Invalid model limits.");
		const checked = {};
		for (const kind of ["detected", "manual"]) {
			if (limits[kind] === undefined) continue;
			if (!record(limits[kind])) throw new Error("Invalid model limits.");
			const entries = Object.entries(limits[kind]).map(([field, entry]) => {
				const valid = kind === "manual" ? validModelLimit(entry, profile.api) :
					record(entry) && validModelLimit(entry.value, profile.api) && sources.has(entry.source);
				if (!fields.includes(field) || !valid) throw new Error("Invalid model limits.");
				return [field, kind === "manual" ? entry : { value: entry.value, source: entry.source }];
			});
			if (entries.length) checked[kind] = Object.fromEntries(entries);
		}
		return [model, checked];
	}).filter(([, limits]) => Object.keys(limits).length));
}
