// Configure providers from an explicit user-driven terminal command.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import { authentication, discoverModels, protocols, providerFromProfile, validModelId } from "./provider-protocols.mjs";
import { providerId, providerKey, providerStore } from "./provider-store.mjs";
import { providerEndpoint } from "./provider-endpoint.mjs";

function hostStore(cwd) {
	const home = realpathSync(homedir());
	if (getAgentDir() !== join(home, ".codey", "agent")) return undefined;
	return providerStore(home, realpathSync(cwd));
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

function picker(ui, catalog, selected) {
	return ui.custom((tui, _theme, keys, done) => {
		const filter = new Input({ prompt: "Search: " });
		const chosen = new Set(selected);
		let cursor = 0;
		const rows = 8;
		const matching = () => catalog.filter((id) => id.toLowerCase().includes(filter.getValue().toLowerCase()));
		const hint = (id) => keys.getKeys(id).join("/");
		return {
			invalidate() {},
			render(width) {
				const filtered = matching();
				const first = Math.max(0, cursor - rows + 1);
				const lines = ["Select catalog models", ...filter.render(width), ...filtered.slice(first, first + rows)
					.map((id, index) => `${index + first === cursor ? ">" : " "} [${chosen.has(id) ? "x" : " "}] ${id}`),
					`${chosen.size} selected · ${hint("tui.select.confirm")} toggle · ${hint("app.models.save")} done · ${hint("tui.select.cancel")} back`];
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
					if (id && !chosen.delete(id)) chosen.add(id);
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
	for (;;) {
		const action = await ui.select(`Models for ${profile.id} (${selected.length} selected)`, [
			"Discover via the model catalog", ...(catalog.length ? ["Search and select discovered models"] : []),
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
			if (action === "Discover via the model catalog") {
				if (!profile.lanHttpApprovedUrl && !await ui.confirm("Request the model catalog?", `${profile.baseUrl}${protocols.get(profile.api).catalog}\nAuthentication: ${authentication.get(profile.auth).label}. No inference request will be sent.`)) continue;
				const result = await discoverModels(profile);
				catalog = result.ids.filter((id) => !profile.key || !id.includes(profile.key));
				if (result.reason) ui.notify(`${result.reason} You can enter model IDs manually.`, "warning");
			}
			if (catalog.length) selected = await picker(ui, catalog, selected) ?? selected;
		}
	}
}

async function draft(ui, id, previous, action) {
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
	const profile = { id, api, baseUrl, auth };
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
	const builtins = new Set(builtinProviders().map(({ id }) => id));
	builtins.add("llama.cpp");
	const errors = [];
	try {
		const saved = hostStore(process.cwd())?.list();
		for (const { profile } of saved?.entries ?? []) {
			if (builtins.has(profile.id)) continue;
			pi.registerProvider(providerFromProfile(profile));
		}
		errors.push(...(saved?.errors ?? []));
	} catch { errors.push("Could not read the private Codey provider directory. Check its ownership and permissions."); }
	pi.on("session_start", (_event, ctx) => {
		if (errors.length) ctx.ui.notify(errors.join("\n"), "warning");
	});
	pi.registerCommand("provider", {
		description: "Add or edit a custom model provider",
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
				const actions = ["Add provider", ...(existing.length ? ["Edit provider or models", "Replace API key"] : [])];
				const action = await ui.select("Custom providers", actions);
				if (action === undefined) return;
				const name = action === "Add provider" ? await ui.input("New provider ID") : await ui.select("Choose saved provider", existing.map(({ profile }) => profile.id));
				if (name === undefined) return;
				const id = providerId(name.trim());
				const entry = action !== "Add provider" ? existing.find(({ profile }) => profile.id === id) : undefined;
				if (builtins.has(id) || store.reserved(id) || (!entry && (ctx.modelRegistry.getProvider(id) || existing.some(({ profile }) => profile.id === id)))) {
					throw new Error("A provider or stored login already uses this ID.");
				}
				const profile = await draft(ui, id, entry?.profile, action);
				if (!profile) return;
				const old = entry?.profile;
				const authChange = old?.auth === "key" && (profile.auth !== "key" || profile.key !== old.key || profile.baseUrl !== old.baseUrl || profile.api !== old.api);
				const summary = `${id}\n${protocols.get(profile.api).label}\n${profile.baseUrl}\n${authentication.get(profile.auth).label}\n${profile.models.length} model IDs${authChange ? "\nThis replaces the saved authentication for this profile." : ""}`;
				if (await ui.select(`Save custom provider?\n${summary}`, ["Cancel", "Save provider"], { blockedKind: "permission" }) !== "Save provider") return;
				store.save(profile, entry?.revision);
				pi.registerProvider(providerFromProfile(profile));
				void ctx.modelRegistry.refresh({ allowNetwork: false, providers: [id], signal: AbortSignal.timeout(4_000) }).catch(() => {});
				const saved = action === "Replace API key" ? "API key replaced for" : "Custom provider saved:";
				ui.notify(`${saved} ${id}. Open /model to select it, or /reload if it is not listed yet.`, "info");
			} catch (error) {
				ui.notify(`Custom provider: ${error.message}`, "error");
			}
		},
	});
}
