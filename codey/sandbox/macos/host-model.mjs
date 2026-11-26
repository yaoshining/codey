// Resolve credentials on the host while excluding executable credential values.
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, FileAuthStorageBackend } from "../../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../../packages/coding-agent/src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../../packages/coding-agent/src/core/models-store.ts";
import { providerFromProfile } from "../../extensions/provider-protocols.mjs";
import { providerStore } from "../../extensions/provider-store.mjs";
import { contains } from "./seatbelt.mjs";

export function parseData(raw, label) {
	if (raw === undefined) return {};
	let data;
	try {
		data = JSON.parse(raw.replace(/^\uFEFF/, ""));
	} catch {
		throw new Error(`Could not parse host ${label} as JSON.`);
	}
	if (data === null || Array.isArray(data) || typeof data !== "object") {
		throw new Error(`Host ${label} must contain a JSON object.`);
	}
	const pending = [data];
	while (pending.length) {
		const value = pending.pop();
		if (typeof value === "string" && value.startsWith("!")) {
			throw new Error(`Command-valued host ${label} is unsupported in the macOS sandbox.`);
		}
		if (value && typeof value === "object") {
			for (const child of Object.values(value)) pending.push(child);
		}
	}
	return data;
}

function readOptional(path) {
	if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Host model configuration must be a small regular file.");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

async function loadModelCache(agentDir) {
	const modelsStore = new InMemoryCodingAgentModelsStore();
	try {
		const cache = parseData(readOptional(join(agentDir, "models-store.json")), "models-store.json");
		for (const [provider, entry] of Object.entries(cache)) {
			if (Array.isArray(entry?.models)) await modelsStore.write(provider, entry);
		}
	} catch {
		// An unreadable optional cache must not prevent use of the installed catalog.
		return { modelsStore, warning: "Could not read the local model cache. Using the installed model catalog." };
	}
	return { modelsStore };
}

export async function hostModel(home, workspace, hostDir) {
	const codey = join(home, ".codey");
	const agentDir = join(codey, "agent");
	for (const path of [codey, agentDir]) {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat && (!stat.isDirectory() || !contains(home, realpathSync(path)) || contains(workspace, realpathSync(path)))) {
			throw new Error("The host Codey configuration must be a directory outside the workspace.");
		}
	}
	const authPath = join(agentDir, "auth.json");
	parseData(readOptional(authPath), "auth.json");
	const auth = new FileAuthStorageBackend(authPath);
	const checked = (callback) => (raw) => {
		parseData(raw, "auth.json");
		return callback(raw);
	};
	const credentials = AuthStorage.fromStorage({
		withLock: (callback) => auth.withLock(checked(callback)),
		withLockAsync: (callback, options) => auth.withLockAsync(checked(callback), options),
	});
	const rawModels = readOptional(join(agentDir, "models.json"));
	let modelsPath = null;
	if (rawModels !== undefined) {
		const models = parseData(rawModels, "models.json");
		modelsPath = join(hostDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify(models), { flag: "wx", mode: 0o600 });
	}
	const settings = parseData(readOptional(join(agentDir, "settings.json")), "settings.json");
	const { modelsStore, warning } = await loadModelCache(agentDir);
	// The local refresh restores cached catalogs and populates the auth/availability
	// snapshot consumed by the SDK's initial model selection.
	const runtime = await ModelRuntime.create({ credentials, modelsPath, modelsStore, allowModelNetwork: false });
	const warnings = [warning].filter(Boolean);
	try {
		const saved = providerStore(home, workspace)?.list();
		if (saved) {
			warnings.push(...saved.errors);
			let registered = false;
			for (const { profile } of saved.entries) {
				if (runtime.getProvider(profile.id)) continue;
				runtime.registerNativeProvider(providerFromProfile(profile));
				registered = true;
			}
			if (registered) await runtime.refresh({ allowNetwork: false });
		}
	} catch { warnings.push("Could not load the private Codey provider directory."); }
	return { runtime, agentDir, settings, warning: warnings.join("\n") || undefined };
}
