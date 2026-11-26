// Persist endpoint, model IDs and optional key together in one private host file.
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { lockSync } from "proper-lockfile";
import { authentication, protocols, validModelId } from "./provider-protocols.mjs";
import { authorizedProviderEndpoint } from "./provider-endpoint.mjs";

const validName = /^[a-z][a-z0-9_-]{0,39}$/;

export function providerId(value) {
	if (typeof value !== "string" || !validName.test(value)) throw new Error("Use a provider ID starting with a lowercase letter, with up to 40 letters, digits, hyphens or underscores.");
	return value;
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
		return (models && Object.hasOwn(parse(models)?.providers ?? {}, id)) || (auth && Object.hasOwn(parse(auth) ?? {}, id));
	}
	return {
		list() {
			const entries = [], errors = [];
			if (!directory()) return { entries, errors };
			for (const file of readdirSync(folder).sort()) {
				const id = file.slice(0, -5);
				if (!file.endsWith(".json") || !validName.test(id)) continue;
				try {
					if (reserved(id)) throw new Error("Its ID is used by models.json or auth.json.");
					const revision = read(join(folder, file), true);
					if (!revision) continue;
					const raw = parse(revision);
					if (!protocols.has(raw.api) || !authentication.has(raw.auth) || !Array.isArray(raw.models) ||
						!raw.models.length || raw.models.length > 500 || !raw.models.every(validModelId)) throw new Error("Invalid profile fields.");
					const { baseUrl, lanHttp } = authorizedProviderEndpoint(raw);
					const profile = { id, api: raw.api, auth: raw.auth, baseUrl, models: [...new Set(raw.models)] };
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
		save(profile, revision) {
			authorizedProviderEndpoint(profile);
			directory(true);
			const id = providerId(profile.id);
			const target = join(folder, `${id}.json`);
			const release = lockSync(folder);
			try {
				if (reserved(id) || read(target, true) !== revision) throw new Error("The provider already exists or changed in another session. Start the wizard again.");
				const temp = mkdtempSync(join(folder, ".write-"));
				try {
					const staged = join(temp, "profile");
					writeFileSync(staged, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
					if (revision === undefined) linkSync(staged, target);
					else renameSync(staged, target);
				} finally { rmSync(temp, { recursive: true, force: true }); }
			} finally { release(); }
		},
	};
}
