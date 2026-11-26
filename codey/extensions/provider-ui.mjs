// Configure providers from an explicit user-driven terminal command.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import { authentication, discoverModels, protocols, providerFromProfile, validModelId } from "./provider-protocols.mjs";
import { providerIdentity, providerKey, providerStore } from "./provider-store.mjs";
import { providerEndpoint } from "./provider-endpoint.mjs";

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

function picker(ui, catalog, selected, catalogStatus) {
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
				const lines = ["Select catalog models", ...(catalogStatus ? [catalogStatus] : []), ...filter.render(width), ...filtered.slice(first, first + rows)
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
	for (;;) {
		const action = await ui.select(`Models for ${providerLabel(profile)} (${selected.length} selected)${catalogStatus ? `\n${catalogStatus}` : ""}`, [
			"Discover via the model catalog", ...(discovery?.continuation ? ["Continue loading model catalog"] : []),
			...(catalog.length ? ["Search and select discovered models"] : []),
			"Enter model IDs manually", "Keep selections and continue",
		]);
		if (action === undefined) return undefined;
		if (action === "Keep selections and continue") {
			if (selected.length) return selected;
			ui.notify("Select or enter at least one model ID.", "warning");
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
	profile.models = await chooseModels(ui, previous?.models ?? [], profile);
	if (profile.models) return profile;
}

export default function customProviders(pi) {
	const builtins = new Set(builtinProviders().map(({ id }) => id.toLowerCase()));
	builtins.add("llama.cpp");
	const registered = new Map();
	function register(profile) {
		const provider = providerFromProfile(profile);
		pi.registerProvider(provider);
		registered.set(profile.id, provider);
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
				const actions = ["Add provider", ...(existing.length ? ["Edit provider or models", "Replace API key", "Rename display name", "Delete provider"] : [])];
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
				if (action === "Rename display name" || action === "Delete provider") {
					await manageProvider(action, entry, store, ctx);
					return;
				}
				const profile = await draft(ui, { id, displayName: identity.displayName }, entry?.profile, action);
				if (!profile) return;
				const old = entry?.profile;
				const authChange = old?.auth === "key" && (profile.auth !== "key" || profile.key !== old.key || profile.baseUrl !== old.baseUrl || profile.api !== old.api);
				const summary = `${providerLabel(profile)}\n${protocols.get(profile.api).label}\n${profile.baseUrl}\n${authentication.get(profile.auth).label}\n${profile.models.length} model IDs${authChange ? "\nThis replaces the saved authentication for this profile." : ""}`;
				if (await ui.select(`Save custom provider?\n${summary}`, ["Cancel", "Save provider"], { blockedKind: "permission" }) !== "Save provider") return;
				checkConflict();
				store.save(profile, entry?.revision);
				register(profile);
				void ctx.modelRegistry.refresh({ allowNetwork: false, providers: [id], signal: AbortSignal.timeout(4_000) }).catch(() => {});
				const saved = action === "Replace API key" ? "API key replaced for" : "Custom provider saved:";
				ui.notify(`${saved} ${providerLabel(profile)}. Open /model to select it, or /reload if it is not listed yet.`, "info");
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
