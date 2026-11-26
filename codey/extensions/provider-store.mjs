// Persist endpoint, model IDs and optional key together in one private host file.
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { lockSync } from "proper-lockfile";
import { authentication, protocols, validModelId } from "./provider-protocols.mjs";
import { authorizedProviderEndpoint } from "./provider-endpoint.mjs";

const validName = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const validId = /^[a-z][a-z0-9_-]{0,39}$/;

function validateDisplayName(name) {
	if (typeof name !== "string" || !validName.test(name)) throw new Error("Use a provider name starting with an ASCII letter, with up to 40 letters, digits, hyphens or underscores.");
	return name;
}

export function providerIdentity(name) {
	const displayName = validateDisplayName(name);
	return { id: displayName.toLowerCase(), displayName };
}

function profileId(file) {
	const name = file.slice(0, -5);
	if (file.slice(-5).toLowerCase() === ".json" && validName.test(name)) return name.toLowerCase();
}

export function providerKey(value) {
	if (typeof value !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(value)) throw new Error("Enter a nonempty API key without spaces or control characters.");
	return value;
}

function read(path, privateFile = false) {
	let fd;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > (privateFile ? 256 * 1024 : 4 * 1024 * 1024) || stat.uid !== process.getuid() || (stat.mode & (privateFile ? 0o077 : 0o022))) {
			throw new Error("Provider settings must use user-owned files with safe permissions.");
		}
		return readFileSync(fd, "utf8");
	} finally { closeSync(fd); }
}

function parse(raw) {
	try { return JSON.parse(raw.replace(/^\uFEFF/, "")); } catch { throw new Error("Provider configuration contains invalid JSON."); }
}

export function providerStore(home, workspace) {
	const codey = join(home, ".codey");
	const agent = join(codey, "agent");
	const folder = join(agent, "custom-providers");
	const rel = relative(workspace, agent);
	if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) return undefined;

	function directory(create = false) {
		for (const path of [codey, agent, folder]) {
			if (create) {
				try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
			}
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (!stat) return false;
			if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
				throw new Error("Provider settings require user-owned host directories without group or public write access.");
			}
		}
		return true;
	}
	function reserved(id) {
		const models = read(join(agent, "models.json"));
		const auth = read(join(agent, "auth.json"));
		const ids = [...Object.keys(models ? parse(models)?.providers ?? {} : {}), ...Object.keys(auth ? parse(auth) ?? {} : {})];
		return ids.some((configuredId) => configuredId.toLowerCase() === id);
	}
	const hasCaseAlias = (files, id) => files.some((file) => file !== `${id}.json` && profileId(file) === id);
	const changed = "The provider already exists or changed in another session. Start the wizard again.";

	function defaultProvider() {
		const settings = read(join(agent, "settings.json"));
		return settings ? parse(settings)?.defaultProvider : undefined;
	}

	function update(id, revision, change) {
		if (typeof id !== "string" || !validId.test(id)) throw new Error("Use the canonical provider ID.");
		if (!directory(revision === undefined)) throw new Error(changed);
		const target = join(folder, `${id}.json`);
		const release = lockSync(folder);
		try {
			if (reserved(id) || hasCaseAlias(readdirSync(folder), id) || read(target, true) !== revision) throw new Error(changed);
			change(target);
		} finally { release(); }
	}

	function write(target, profile, creating) {
		const temp = mkdtempSync(join(folder, ".write-"));
		try {
			const staged = join(temp, "profile");
			writeFileSync(staged, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			if (creating) linkSync(staged, target);
			else renameSync(staged, target);
		} finally { rmSync(temp, { recursive: true, force: true }); }
	}

	return {
		has(id) {
			return directory() && readdirSync(folder).some((file) => profileId(file) === id);
		},
		list() {
			const entries = [], errors = [];
			if (!directory()) return { entries, errors };
			const files = readdirSync(folder).sort();
			const aliases = new Set();
			for (const file of files) {
				const id = profileId(file);
				if (id !== undefined && file !== `${id}.json`) aliases.add(id);
			}
			for (const file of files) {
				const id = profileId(file);
				if (id === undefined || file !== `${id}.json`) continue;
				try {
					if (reserved(id) || aliases.has(id)) throw new Error("Its ID is already used.");
					const revision = read(join(folder, file), true);
					if (!revision) continue;
					const raw = parse(revision);
					if (!protocols.has(raw.api) || !authentication.has(raw.auth) || !Array.isArray(raw.models) ||
						!raw.models.length || raw.models.length > 500 || !raw.models.every(validModelId)) throw new Error("Invalid profile fields.");
					const { baseUrl, lanHttp } = authorizedProviderEndpoint(raw);
					const displayName = validateDisplayName(Object.hasOwn(raw, "displayName") ? raw.displayName : id);
					const profile = { id, displayName, api: raw.api, auth: raw.auth, baseUrl, models: [...new Set(raw.models)] };
					if (lanHttp) profile.lanHttpApprovedUrl = raw.lanHttpApprovedUrl;
					if (raw.auth === "key") profile.key = providerKey(raw.key);
					entries.push({ profile, revision });
				} catch {
					errors.push(`Could not load custom provider "${id}". Check its file, permissions, and ID conflicts.`);
				}
			}
			return { entries, errors };
		},
		reserved,
		defaultProvider,
		save(profile, revision) {
			authorizedProviderEndpoint(profile);
			validateDisplayName(profile.displayName);
			update(profile.id, revision, (target) => write(target, profile, revision === undefined));
		},
		renameDisplayName(id, revision, name) {
			const displayName = validateDisplayName(name);
			if (typeof revision !== "string") throw new Error(changed);
			update(id, revision, (target) => write(target, { ...parse(revision), displayName }, false));
		},
		remove(id, revision) {
			if (typeof revision !== "string") throw new Error(changed);
			update(id, revision, (target) => {
				if (defaultProvider() === id) throw new Error("Set a different default with /model before deleting this provider.");
				unlinkSync(target);
			});
		},
	};
}
