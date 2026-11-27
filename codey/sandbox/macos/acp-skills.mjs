// Fixed discovery roots. Project calls run in the existing Seatbelt worker.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseFrontmatter } from "../../../packages/coding-agent/src/utils/frontmatter.ts";

const maxHeader = 8 * 1024;
const maxSkill = 48 * 1024;
const maxEntries = 512;
const maxCatalog = 64;
const maxDiagnostics = 16;
const decoder = new TextDecoder("utf-8", { fatal: true });
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const projectSkillsCommand = "project-skills";
const pendingDescription = "External personal skill · approval required before use";
const validName = (name) => typeof name === "string" && name.length <= 64 && namePattern.test(name) && name !== projectSkillsCommand;

function owned(stat, uid) {
	return uid === undefined || (stat.uid === uid && (stat.mode & 0o022) === 0);
}

function checkedDirectory(path, uid) {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || !owned(stat, uid) || realpathSync(path) !== path) throw new Error("Invalid skill directory.");
	return path;
}

const codeySkills = [".codey", "agent", "skills"];
const agentSkills = [".agents", "skills"];

function relativeChild(base, path) {
	const child = relative(base, path);
	return child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child) ? child : undefined;
}

function skillRoots(canonicalBase, scope) {
	const uid = scope === "user" ? process.getuid() : undefined;
	return (scope === "user" ? [codeySkills, agentSkills] : [agentSkills]).flatMap((parts) => {
		try {
			const root = parts.reduce((parent, part) => checkedDirectory(join(parent, part), uid), canonicalBase);
			return [{ root, uid }];
		} catch { return []; }
	});
}

function resolveEntry(base, roots, { root, uid }, name) {
	const entry = join(root, name);
	const stat = lstatSync(entry, { throwIfNoEntry: false });
	if (!stat?.isDirectory() && !stat?.isSymbolicLink()) return {};
	if (uid !== undefined && stat.uid !== uid) return { reason: "Skill entry needs user ownership." };
	let directory;
	try { directory = realpathSync(entry); } catch {
		return { reason: "Skill directory link is broken, inaccessible, or cyclic." };
	}
	if (!stat.isSymbolicLink()) return { path: join(checkedDirectory(entry, uid), "SKILL.md") };
	if (uid === undefined) {
		if (!relativeChild(base, directory)) return { reason: "Project skill link leaves the sandbox workspace." };
	} else {
		const targetRoot = roots.find(({ root: known }) => relativeChild(known, directory));
		if (!targetRoot) return { path: join(directory, "SKILL.md"), linked: true, external: true };
		const child = relativeChild(targetRoot.root, directory);
		child.split(sep).reduce((parent, part) => checkedDirectory(join(parent, part), uid), targetRoot.root);
	}
	return { path: join(checkedDirectory(directory, uid), "SKILL.md"), linked: true };
}

function fileAllowed(stat, uid, external) {
	return stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maxSkill &&
		(external ? stat.uid === uid && (stat.mode & 0o002) === 0 : owned(stat, uid));
}

function readSkill(path, uid, name, full, external = false, expectedHash) {
	try {
		const before = lstatSync(path);
		if (!fileAllowed(before, uid, external) || realpathSync(path) !== path) return;
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = fstatSync(fd);
			if (!fileAllowed(stat, uid, external) || stat.dev !== before.dev || stat.ino !== before.ino || realpathSync(path) !== path) return;
			const readBody = full || external;
			const buffer = Buffer.alloc(Math.min(stat.size, readBody ? maxSkill : maxHeader) + 1);
			let size = 0, headerLength = 0;
			while (size < buffer.length) {
				const count = readSync(fd, buffer, size, Math.min(512, buffer.length - size), size);
				if (!count) break;
				size += count;
				if (!headerLength) {
					// Find the delimiters in bytes so an incomplete UTF-8 body never affects metadata.
					const header = /^(?:\xef\xbb\xbf)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(buffer.toString("latin1", 0, Math.min(size, maxHeader)));
					if (header && (header[0].endsWith("\n") || size === stat.size)) headerLength = header[0].length;
				}
				if (!readBody && headerLength) break;
			}
			if (!headerLength || (readBody && (size !== stat.size || size > maxSkill))) return;
			const after = lstatSync(path);
			if (!fileAllowed(after, uid, external) || after.dev !== stat.dev || after.ino !== stat.ino || realpathSync(path) !== path) return;
			const sha256 = external ? createHash("sha256").update(buffer.subarray(0, size)).digest("hex") : undefined;
			if (expectedHash && sha256 !== expectedHash) return;
			const { frontmatter } = parseFrontmatter(decoder.decode(buffer.subarray(0, headerLength)));
			if (frontmatter.name !== name || typeof frontmatter.description !== "string" || frontmatter["user-invocable"] === false) return;
			const description = frontmatter.description.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim().slice(0, 240);
			if (!description) return;
			if (!readBody) return { name, description };
			const body = decoder.decode(buffer.subarray(headerLength, size)).trim();
			if (!body || body.includes("\0") || /!\s*`/.test(body)) return;
			return { name, description, ...(full ? { body } : {}), ...(sha256 ? { sha256 } : {}) };
		} finally { closeSync(fd); }
	} catch { /* Invalid or concurrently changed skills are unavailable. */ }
}

function trustDirectory(home, create = false) {
	const uid = process.getuid();
	return [".codey", "agent", "acp-skill-trust"].reduce((parent, part) => {
		const path = join(parent, part);
		if (create) {
			try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
				if (error.code !== "EEXIST") throw error;
			}
		}
		const canonical = checkedDirectory(path, uid);
		if (part === "acp-skill-trust" && (lstatSync(path).mode & 0o077)) throw new Error("Skill trust storage must be private.");
		return canonical;
	}, home);
}

function trustRecord(home, name) {
	try {
		const path = join(trustDirectory(home), `${name}.json`);
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 8192) return;
			const data = Buffer.alloc(stat.size + 1);
			if (readSync(fd, data) !== stat.size) return;
			return JSON.parse(decoder.decode(data.subarray(0, stat.size)));
		} finally { closeSync(fd); }
	} catch { /* Missing or invalid approvals do not authorize access. */ }
}

function skillAt(base, roots, location, name, full) {
	try {
		const { path, external, linked, reason } = resolveEntry(base, roots, location, name);
		if (!path) return { reason };
		const trust = location.uid !== undefined && linked ? trustRecord(base, name) : undefined;
		// Checking an unapproved external link only uses filesystem metadata, never SKILL.md bytes.
		if (external && (!fileAllowed(lstatSync(path), location.uid, true) || realpathSync(path) !== path)) {
			return { reason: "External SKILL.md must be a user-owned regular file within the size and permission limits." };
		}
		if (trust?.root === location.root && trust.path !== path) {
			return { pending: Boolean(external), reason: "Approved external skill link now points to a different file." };
		}
		if (!external) return { skill: readSkill(path, location.uid, name, full) };
		if (trust?.root !== location.root || trust?.path !== path || !/^[a-f0-9]{64}$/.test(trust?.sha256 ?? "")) {
			return { pending: true, reason: "External personal skill link needs approval." };
		}
		const skill = readSkill(path, location.uid, name, full, true, trust.sha256);
		return skill ? { skill } : { pending: true, reason: "Approved external skill changed or became unreadable." };
	} catch { return { reason: "Skill directory does not meet its scope or ownership requirements." }; }
}

// The host calls this only with its canonical Home. The worker uses its sandbox cwd.
export function discoverSkills(base, scope) {
	const skills = new Map();
	const pending = new Set();
	const skipped = new Map();
	let partial = false;
	const roots = skillRoots(base, scope);
	for (const location of roots) {
		try {
			const directory = opendirSync(location.root);
			let count = 0, entry;
			try {
				while (count++ < maxEntries && (entry = directory.readSync())) {
					if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !validName(entry.name) || skills.has(entry.name)) continue;
					const { skill, pending: needsApproval, reason } = skillAt(base, roots, location, entry.name, false);
					if (skill) skills.set(skill.name, skill);
					else if (needsApproval) pending.add(entry.name);
					else if (reason && skipped.size < maxDiagnostics) skipped.set(entry.name, reason);
				}
			} finally { directory.closeSync(); }
			partial ||= count > maxEntries;
		} catch { /* A missing root must not hide skills in the other root. */ }
	}
	// Usable entries keep their priority and cannot be displaced by an unapproved link with the same name.
	const usable = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
	const waiting = [...pending].filter((name) => !skills.has(name)).sort();
	const entries = [...usable.map(({ name, description }) => ({ name, description })),
		...waiting.map((name) => ({ name, description: pendingDescription, pending: true }))];
	return { skills: entries.slice(0, maxCatalog), skipped: [...skipped].filter(([name]) => !skills.has(name) && !pending.has(name)),
		partial: partial || entries.length > maxCatalog };
}

export function loadSkill(base, scope, name) {
	if (!validName(name)) return {};
	const roots = skillRoots(base, scope);
	let reason;
	let waiting;
	for (const [index, location] of roots.entries()) {
		// The preferred root also takes precedence when its body cannot be loaded.
		const metadata = index < roots.length - 1 ? skillAt(base, roots, location, name, false) : undefined;
		if (!metadata || metadata.skill) {
			const result = skillAt(base, roots, location, name, true);
			return result.skill || result.pending ? result : (waiting ?? { ...result, reason: result.reason ?? reason });
		}
		if (metadata.pending) waiting ??= metadata;
		reason ??= metadata.reason;
	}
	return waiting ?? { reason };
}

export function manageSkillTrust(home, [action, name, target, hash, ...extra]) {
	const help = "Usage: codey acp skills inspect <name> | trust <name> <canonical-SKILL.md-path> <sha256> | untrust <name>";
	if (action === undefined || action === "--help") return help;
	if (!validName(name) || extra.length || !["inspect", "trust", "untrust"].includes(action) ||
		(action === "trust" ? (!target || !/^[a-f0-9]{64}$/.test(hash ?? "")) : target !== undefined)) throw new Error(help);
	if (action === "untrust") {
		unlinkSync(join(trustDirectory(home), `${name}.json`));
		return `Removed external skill approval for ${name}.`;
	}
	const roots = skillRoots(home, "user");
	for (const location of roots) {
		const entry = resolveEntry(home, roots, location, name);
		if (!entry.external) continue;
		if (action === "trust" && target !== entry.path) throw new Error("The link target changed. Inspect it again.");
		const skill = readSkill(entry.path, location.uid, name, false, true, hash);
		if (!skill) throw new Error("External SKILL.md is invalid, unreadable, or its SHA-256 changed. Inspect the target again.");
		const approval = { root: location.root, path: entry.path, sha256: skill.sha256 };
		if (action === "inspect") return JSON.stringify(approval, null, 2);
		try {
			writeFileSync(join(trustDirectory(home, true), `${name}.json`), JSON.stringify(approval), { mode: 0o600, flag: "wx" });
		} catch (error) {
			if (error.code === "EEXIST") throw new Error("This skill already has an approval. Remove it with untrust before approving again.");
			throw error;
		}
		return `Approved the exact SKILL.md for ${name}. Refresh the ACP provider.`;
	}
	throw new Error("No external personal skill link with that name was found in the supported roots.");
}
