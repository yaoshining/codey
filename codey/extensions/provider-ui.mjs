// Configure providers from an explicit user-driven terminal command.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import { authentication, discoverModelLimits, discoverModels, modelInfoUrl, protocols, providerFromProfile, supportedEffortValues, validModelId } from "./provider-protocols.mjs";
import { providerIdentity, providerKey, providerStore } from "./provider-store.mjs";
import { providerEndpoint } from "./provider-endpoint.mjs";
import { limitFields, modelLimitSettings, validModelLimit, validateModelLimits } from "./provider-limits.mjs";

function hostStore(cwd) {
	const home = realpathSync(homedir());
	if (getAgentDir() !== join(home, ".codey", "agent")) return undefined;
	return providerStore(home, realpathSync(cwd));
}

function providerLabel({ id, displayName }) {
	return displayName === id ? id : `${displayName} (ID: ${id})`;
}

function providerInput(ui, title, { initial = "", secret = false } = {}) {
	return ui.custom((tui, _theme, keys, done) => {
		const input = new Input();
		input.setValue(initial);
		const finish = (value) => { input.setValue(""); done(value); };
		input.onSubmit = finish;
		input.onEscape = () => finish(undefined);
		return {
			render: (width) => [truncateToWidth(title, width), ...(secret
				? [`> ${"*".repeat(Math.min(input.getValue().length, Math.max(0, width - 2)))}`]
				: input.render(width)),
				truncateToWidth(`${keys.getKeys("tui.input.submit").join("/")} submit · ${keys.getKeys("tui.select.cancel").join("/")} cancel`, width)],
			invalidate() {},
			handleInput(data) { input.handleInput(data); tui.requestRender(); },
			dispose() { input.setValue(""); },
		};
	}, { blocked: { kind: "question", message: title } });
}

function picker(ui, catalog, selected, catalogStatus, title = "Select catalog models") {
	return ui.custom((tui, _theme, keys, done) => {
		const filter = new Input({ prompt: "Search: " });
		const chosen = new Set(selected);
		const names = catalog.map((id) => id.toLowerCase());
		let cursor = 0;
		let query;
		let results = catalog;
		let selectionLimit = false;
		const rows = 8;
		const matching = () => {
			const input = filter.getValue();
			if (input === query) return results;
			query = input;
			const needle = input.toLowerCase();
			const exact = [], prefix = [], substring = [];
			for (const [index, name] of names.entries()) {
				if (name === needle) exact.push(catalog[index]);
				else if (name.startsWith(needle)) prefix.push(catalog[index]);
				else if (name.includes(needle)) substring.push(catalog[index]);
			}
			results = [...exact, ...prefix, ...substring];
			return results;
		};
		const hint = (id) => keys.getKeys(id).join("/");
		return {
			invalidate() {},
			render(width) {
				const filtered = matching();
				const first = Math.max(0, cursor - rows + 1);
				const lines = [title, ...(catalogStatus ? [catalogStatus] : []), ...filter.render(width), ...filtered.slice(first, first + rows)
					.map((id, index) => `${index + first === cursor ? ">" : " "} [${chosen.has(id) ? "x" : " "}] ${id}`),
					`${chosen.size} selected · ${hint("tui.select.confirm")} toggle · ${hint("app.models.save")} done · ${hint("tui.select.cancel")} back`,
					...(selectionLimit ? ["Up to 500 models can be saved per provider."] : [])];
				return lines.map((line) => truncateToWidth(line, width));
			},
			handleInput(data) {
				const filtered = matching();
				if (keys.matches(data, "tui.select.cancel")) return done(undefined);
				if (keys.matches(data, "app.models.save")) return done([...chosen]);
				if (keys.matches(data, "tui.select.up")) cursor = Math.max(0, cursor - 1);
				else if (keys.matches(data, "tui.select.down")) cursor = Math.max(0, Math.min(filtered.length - 1, cursor + 1));
				else if (keys.matches(data, "tui.select.confirm")) {
					const id = filtered[cursor];
					selectionLimit = Boolean(id && !chosen.has(id) && chosen.size >= 500);
					if (id && !selectionLimit && !chosen.delete(id)) chosen.add(id);
				} else {
					filter.handleInput(data);
					cursor = 0;
				}
				tui.requestRender();
			},
		};
	}, { blocked: { kind: "question", message: "Choose models" } });
}

async function chooseModels(ui, initial, profile) {
	let selected = [...initial];
	let catalog = [];
	let discovery;
	let catalogStatus = "";
	const edits = new Map();
	const limitsFor = (model) => {
		if (edits.has(model)) return edits.get(model);
		const saved = Object.hasOwn(profile.modelLimits ?? {}, model) ? profile.modelLimits[model] : {};
		const reported = discovery?.limits?.get(model);
		return reported ? { ...saved, detected: { ...saved.detected, ...reported } } : saved;
	};
	for (;;) {
		const action = await ui.select(`Models for ${providerLabel(profile)} (${selected.length} selected)${catalogStatus ? `\n${catalogStatus}` : ""}`, [
			"Discover via the model catalog", ...(discovery?.continuation ? ["Continue loading model catalog"] : []),
			...(catalog.length ? ["Search and select discovered models"] : []),
			"Enter model IDs manually", "Keep selections and continue", ...(selected.length ? ["Configure model limits"] : []),
		]);
		if (action === undefined) return undefined;
		if (action === "Keep selections and continue") {
			if (selected.length) return { models: selected, modelLimits: validateModelLimits({ ...profile, models: selected },
				Object.fromEntries(selected.map((model) => [model, limitsFor(model)]))) };
			ui.notify("Select or enter at least one model ID.", "warning");
		} else if (action === "Configure model limits") {
			const model = await ui.select("Choose a model for token limits", selected);
			if (model !== undefined) {
				const result = await editLimits(ui, profile, model, limitsFor(model));
				if (result) edits.set(model, result);
			}
		} else if (action === "Enter model IDs manually") {
			const input = await providerInput(ui, "Model IDs (one ID or a JSON array)", { initial: selected.length ? JSON.stringify(selected) : "" });
			if (input === undefined) continue;
			const data = input.trim();
			let ids;
			try { ids = data.startsWith("[") ? JSON.parse(data) : data ? [data] : []; }
			catch { throw new Error('Use one model ID or a JSON array such as ["model-a", "model-b"].'); }
			if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => !validModelId(id) || (profile.key && id.includes(profile.key)))) {
				throw new Error("Enter at most 500 valid model IDs without credentials.");
			}
			selected = [...new Set(ids)];
		} else {
			if (action === "Discover via the model catalog" || action === "Continue loading model catalog") {
				const resume = action === "Continue loading model catalog";
				if (!resume && !profile.lanHttpApprovedUrl && !await ui.confirm("Request the model catalog?", `${profile.baseUrl}${protocols.get(profile.api).catalog}\nAuthentication: ${authentication.get(profile.auth).label}. No inference request will be sent.`)) continue;
				discovery = await discoverModels(profile, resume ? discovery.continuation : undefined);
				for (const [model, limits] of edits) {
					const reported = discovery.limits?.get(model);
					if (reported) edits.set(model, { ...limits, detected: { ...limits.detected, ...reported } });
				}
				catalog = discovery.ids;
				catalogStatus = discovery.partial ? `Only ${catalog.length} model IDs loaded.` : "";
				if (discovery.reason) {
					ui.notify(`${catalogStatus ? `${catalogStatus} ` : ""}${discovery.reason} You can enter model IDs manually.`, "warning");
				}
				// Leave the action menu visible when more pages can be loaded.
				if (discovery.continuation) continue;
			}
			if (catalog.length) selected = await picker(ui, catalog, selected, catalogStatus) ?? selected;
		}
	}
}

const limitActions = new Map(Object.entries(limitFields).map(([field, label]) => [`Edit ${label.toLowerCase()}`, field]));

function limitSummary(profile, model, settings) {
	return Object.entries(modelLimitSettings(profile, model, settings)).map(([field, { value, source, capped }]) =>
		`${limitFields[field]}: ${value} tokens (${source}${capped ? ", capped by context" : ""})`).join("\n");
}

async function editLimits(ui, profile, model, initial) {
	let limits = initial ?? {};
	for (;;) {
		const action = await ui.select(`Token limits for ${model}\n${limitSummary(profile, model, limits)}`, [
			"Read gateway limits", ...limitActions.keys(), "Keep model limits",
		]);
		if (action === undefined) return;
		if (action === "Keep model limits") return limits;
		if (action === "Read gateway limits") {
			if (!await ui.confirm("Read limits from the configured gateway?",
				`${profile.baseUrl}${protocols.get(profile.api).catalog}\nIf needed: ${modelInfoUrl(profile).href}\nNo inference request will be sent.`)) continue;
			const result = await discoverModelLimits(profile, model);
			limits = { ...limits, detected: result.limits };
			if (result.reason) ui.notify(`${result.reason} Missing limits remain unknown.`, "warning");
			continue;
		}
		const field = limitActions.get(action);
		const input = await providerInput(ui, `${limitFields[field]} in tokens (blank uses automatic limits)`, {
			initial: limits.manual?.[field]?.toString() ?? "",
		});
		if (input === undefined) continue;
		const manual = { ...limits.manual };
		const value = input.trim();
		if (!value) delete manual[field];
		else if (/^\d+$/.test(value) && validModelLimit(Number(value), profile.api)) manual[field] = Number(value);
		else {
			ui.notify("Enter a whole number up to 10000000. OpenAI Responses requires at least 16 tokens.", "warning");
			continue;
		}
		limits = { ...limits, manual };
	}
}

async function draft(ui, identity, previous, action) {
	if (action === "Replace API key") {
		const input = await providerInput(ui, "API key (masked)", { secret: true });
		if (input === undefined) return;
		return { ...previous, auth: "key", key: providerKey(input) };
	}
	const ordered = (choices, current) => [...new Set([...(current ? [choices.get(current).label] : []), ...[...choices.values()].map(({ label }) => label)])];
	const protocolLabel = await ui.select("Provider protocol", ordered(protocols, previous?.api));
	if (protocolLabel === undefined) return;
	const api = [...protocols].find(([, value]) => value.label === protocolLabel)[0];
	const title = api === "anthropic-messages" ? "API Base URL (without trailing /v1)" : "API Base URL (include /v1 if required)";
	const url = await providerInput(ui, title, { initial: previous?.baseUrl });
	if (url === undefined) return;
	const { baseUrl, lanHttp } = providerEndpoint(url.trim(), api);
	if (lanHttp && previous?.lanHttpApprovedUrl !== baseUrl) {
		const allow = "Allow unencrypted HTTP for this Base URL";
		if (await ui.select(
			`Use unencrypted LAN HTTP?\n${baseUrl}\nAPI keys, prompts, code, and responses are sent without encryption.`,
			["Cancel", allow], { blockedKind: "permission" },
		) !== allow) return;
	}
	const label = await ui.select("Provider authentication", ordered(authentication, previous?.auth));
	if (label === undefined) return;
	const auth = [...authentication].find(([, value]) => value.label === label)[0];
	const profile = { ...identity, api, baseUrl, auth };
	if (lanHttp) profile.lanHttpApprovedUrl = baseUrl;
	if (auth === "key") {
		if (previous?.auth === "key" && previous.baseUrl === baseUrl && previous.api === api) profile.key = previous.key;
		else {
			const input = await providerInput(ui, "API key (masked)", { secret: true });
			if (input === undefined) return;
			profile.key = providerKey(input);
		}
	}
	if (previous?.modelLimits) {
		const sameRoute = previous.baseUrl === baseUrl && previous.api === api;
		profile.modelLimits = Object.fromEntries(Object.entries(previous.modelLimits).map(([model, limits]) => [model, sameRoute ? limits : {
			manual: limits.manual,
		}]));
	}
	const chosen = await chooseModels(ui, previous?.models ?? [], profile);
	if (!chosen) return;
	profile.models = chosen.models;
	if (Object.keys(chosen.modelLimits).length) profile.modelLimits = chosen.modelLimits;
	else delete profile.modelLimits;
	if (previous?.reasoningLevels && previous.baseUrl === baseUrl && previous.api === api) {
		const entries = Object.entries(previous.reasoningLevels).filter(([model]) => profile.models.includes(model));
		if (entries.length) profile.reasoningLevels = Object.fromEntries(entries);
	}
	return profile;
}

export default function customProviders(pi) {
	const builtins = new Set(builtinProviders().map(({ id }) => id.toLowerCase()));
	builtins.add("llama.cpp");
	const registered = new Map();
	function register(profile) {
		const provider = providerFromProfile(profile);
		pi.registerProvider(provider);
		registered.set(profile.id, provider);
		return provider;
	}
	async function applyActiveLimits(ctx, id, provider) {
		if (ctx.model?.provider !== id) return true;
		const next = provider.getModels().find((model) => model.id === ctx.model.id);
		return !next || (next.contextWindow === ctx.model.contextWindow && next.maxTokens === ctx.model.maxTokens) || await pi.setModel(next);
	}
	const errors = [];
	try {
		const saved = hostStore(process.cwd())?.list();
		for (const { profile } of saved?.entries ?? []) {
			if (builtins.has(profile.id)) continue;
			register(profile);
		}
		errors.push(...(saved?.errors ?? []));
	} catch { errors.push("Could not read the private Codey provider directory. Check its ownership and permissions."); }
	pi.on("session_start", (_event, ctx) => {
		if (errors.length) ctx.ui.notify(errors.join("\n"), "warning");
	});
	pi.registerCommand("provider", {
		description: "Manage custom model providers",
		async handler(args, ctx) {
			if (args.trim() || ctx.mode !== "tui" || !ctx.hasUI || !ctx.isIdle()) {
				ctx.ui.notify("Use /provider in an idle ordinary Codey terminal.", "warning");
				return;
			}
			const { ui } = ctx;
			try {
				const store = hostStore(ctx.cwd);
				if (!store) throw new Error("The wizard needs the default ~/.codey/agent outside the workspace.");
				const existing = store.list().entries.filter(({ profile }) => !builtins.has(profile.id));
				const actions = ["Add provider", ...(existing.length ? ["Edit provider or models", "Replace API key", "Rename display name", "Delete provider", "Configure model reasoning", "Configure model limits"] : [])];
				const action = await ui.select("Custom providers", actions);
				if (action === undefined) return;
				const adding = action === "Add provider";
				const name = adding ? await ui.input("New provider name") : await ui.select("Choose saved provider", existing.map(({ profile }) => providerLabel(profile)));
				if (name === undefined) return;
				const entry = adding ? undefined : existing.find(({ profile }) => providerLabel(profile) === name);
				const identity = entry?.profile ?? providerIdentity(name.trim());
				const { id } = identity;
				const checkConflict = () => {
					const registry = ctx.modelRegistry;
					if (builtins.has(id) || store.reserved(id) ||
						(adding && (store.has(id) || registry.getProvider(id) ||
							registry.getAll().some(({ provider }) => provider.toLowerCase() === id) ||
							registry.getModelsOfType("image").some(({ provider }) => provider.toLowerCase() === id) ||
							registry.getModelsOfType("classifier").some(({ provider }) => provider.toLowerCase() === id)))) {
						throw new Error("A provider or stored login already uses this ID.");
					}
				};
				checkConflict();
				if (["Rename display name", "Delete provider", "Configure model reasoning", "Configure model limits"].includes(action)) {
					await manageProvider(action, entry, store, ctx);
					return;
				}
				const profile = await draft(ui, { id, displayName: identity.displayName }, entry?.profile, action);
				if (!profile) return;
				const old = entry?.profile;
				const authChange = old?.auth === "key" && (profile.auth !== "key" || profile.key !== old.key || profile.baseUrl !== old.baseUrl || profile.api !== old.api);
				const hadReasoning = Object.keys(old?.reasoningLevels ?? {}).length;
				const droppedReasoning = Object.keys(profile.reasoningLevels ?? {}).length < hadReasoning;
				const summary = `${providerLabel(profile)}\n${protocols.get(profile.api).label}\n${profile.baseUrl}\n${authentication.get(profile.auth).label}\n${profile.models.length} model IDs${authChange ? "\nThis replaces the saved authentication for this profile." : ""}${droppedReasoning ? "\nChanged routes or removed models lose their saved reasoning levels." : ""}`;
				if (await ui.select(`Save custom provider?\n${summary}`, ["Cancel", "Save provider"], { blockedKind: "permission" }) !== "Save provider") return;
				checkConflict();
				store.save(profile, entry?.revision);
				const provider = register(profile);
				void ctx.modelRegistry.refresh({ allowNetwork: false, providers: [id], signal: AbortSignal.timeout(4_000) }).catch(() => {});
				const saved = action === "Replace API key" ? "API key replaced for" : "Custom provider saved:";
				const active = await applyActiveLimits(ctx, id, provider);
				ui.notify(`${saved} ${providerLabel(profile)}. ${active ? "Open /model to select it, or /reload if it is not listed yet." : "Reselect the current model with /model to apply its limits."}`, "info");
			} catch (error) {
				ui.notify(`Custom provider: ${error.message}`, "error");
			}
		},
	});

	async function manageProvider(action, { profile, revision }, store, ctx) {
		const { ui } = ctx;
		const { id } = profile;
		function checkRuntime() {
			if (!ctx.isIdle()) throw new Error("Wait for the current turn to finish.");
			const active = ctx.modelRegistry.getProvider(id);
			if (active && active !== registered.get(id)) throw new Error("This provider ID is also registered by another source. Reload after resolving the conflict.");
			return active;
		}

		checkRuntime();
		if (action === "Configure model limits") {
			const model = await ui.select("Choose a model for token limits", profile.models);
			if (model === undefined) return;
			const original = Object.hasOwn(profile.modelLimits ?? {}, model) ? profile.modelLimits[model] : undefined;
			const limits = await editLimits(ui, profile, model, original);
			if (!limits) return;
			const modelLimits = validateModelLimits(profile, { ...profile.modelLimits, [model]: limits });
			const draft = { ...profile };
			if (Object.keys(modelLimits).length) draft.modelLimits = modelLimits;
			else delete draft.modelLimits;
			const save = "Save model limits";
			if (await ui.select(`Save token limits for ${model}?\n${limitSummary(draft, model)}`, ["Cancel", save], { blockedKind: "permission" }) !== save) return;
			checkRuntime();
			store.save(draft, revision);
			const provider = register(draft);
			if (!await applyActiveLimits(ctx, id, provider)) {
				ui.notify("Model limits saved. Reselect the current model with /model to apply them.", "info");
			} else ui.notify(`Model limits saved for ${id}/${model}.`, "info");
			return;
		}
		if (action === "Configure model reasoning") {
			const allowed = supportedEffortValues(profile.api);
			if (!allowed.length) throw new Error("Anthropic Messages uses a different reasoning configuration and is unavailable here.");
			const model = await ui.select("Choose an existing model", profile.models);
			if (model === undefined) return;
			const saved = Object.hasOwn(profile.reasoningLevels ?? {}, model) ? profile.reasoningLevels[model] : [];
			const levels = await picker(ui, allowed, saved, "Select only levels supported by this route. Save no levels to clear.", "Select supported reasoning levels");
			if (!levels) return;
			const summary = levels.length ? levels.join(", ") : "Gateway default (clear reasoning configuration)";
			if (await ui.select(`Save reasoning levels for ${model}?\n${summary}`, ["Cancel", "Save reasoning levels"], { blockedKind: "permission" }) !== "Save reasoning levels") return;
			checkRuntime();
			const reasoningLevels = store.setModelReasoning(id, revision, model, levels);
			register({ ...profile, reasoningLevels });
			ui.notify(`Reasoning settings saved for ${id}/${model}. Use /thinking to choose a supported level.`, "info");
			return;
		}
		if (action === "Rename display name") {
			const input = await providerInput(ui, `Display name for ${id}`, { initial: profile.displayName });
			if (input === undefined || input.trim() === profile.displayName) return;
			const displayName = input.trim();
			checkRuntime();
			store.renameDisplayName(id, revision, displayName);
			register({ ...profile, displayName });
			ui.notify(`Provider display name saved: ${providerLabel({ id, displayName })}.`, "info");
			return;
		}

		function checkDeletion() {
			const active = checkRuntime();
			if (ctx.model?.provider === id) throw new Error("Select a different current model with /model before deleting this provider.");
			if (pi.getSettings().defaultProvider === id || store.defaultProvider() === id) {
				throw new Error("Set a different default with /model before deleting this provider.");
			}
			if (ctx.scopedModels.some(({ model }) => model.provider === id)) {
				throw new Error("Remove this provider's models from /scoped-models before deleting it.");
			}
			return active;
		}

		checkDeletion();
		const remove = "Delete provider and saved data";
		const summary = `Delete ${providerLabel(profile)}?\nRemove the saved connection and ${profile.models.length} model IDs${profile.auth === "key" ? ", its saved API key" : ""}${profile.lanHttpApprovedUrl ? ", and its LAN HTTP approval" : ""}.`;
		if (await ui.select(summary, ["Cancel", remove], { blockedKind: "permission" }) !== remove) return;
		const active = checkDeletion();
		store.remove(id, revision);
		if (active) pi.unregisterProvider(id);
		registered.delete(id);
		ui.notify(`Custom provider deleted: ${providerLabel(profile)}.`, "info");
	}
}
