// Fixed skill roots only. Project calls run in the existing Seatbelt worker.
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../../packages/coding-agent/src/utils/frontmatter.ts";

const maxHeader = 8 * 1024;
const maxSkill = 48 * 1024;
const maxEntries = 512;
const maxCatalog = 64;
const decoder = new TextDecoder("utf-8", { fatal: true });
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const projectSkillsCommand = "project-skills";
const validName = (name) => typeof name === "string" && name.length <= 64 && namePattern.test(name) && name !== projectSkillsCommand;

function owned(stat, uid) {
	return uid === undefined || (stat.uid === uid && (stat.mode & 0o022) === 0);
}

function checkedDirectory(path, uid) {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || !owned(stat, uid) || realpathSync(path) !== path) throw new Error("Invalid skill directory.");
	return path;
}

function roots(canonicalBase, scope) {
	const uid = scope === "user" ? process.getuid() : undefined;
	const parts = scope === "user" ? [".codey", "agent", "skills"] : [".agents", "skills"];
	const root = parts.reduce((parent, part) => checkedDirectory(join(parent, part), uid), canonicalBase);
	return { root, uid };
}

function readSkill({ root, uid }, name, full) {
	try {
		const directory = checkedDirectory(join(root, name), uid);
		const path = join(directory, "SKILL.md");
		const before = lstatSync(path);
		if (!before.isFile() || before.nlink !== 1 || !owned(before, uid) || before.size > maxSkill) return;
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino ||
				stat.nlink !== 1 || !owned(stat, uid) || stat.size > maxSkill || realpathSync(path) !== path) return;
			const buffer = Buffer.alloc(Math.min(stat.size, full ? maxSkill : maxHeader) + 1);
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
				if (!full && headerLength) break;
			}
			if (!headerLength || (full && size > maxSkill)) return;
			const { frontmatter } = parseFrontmatter(decoder.decode(buffer.subarray(0, headerLength)));
			if (frontmatter.name !== name || typeof frontmatter.description !== "string" || frontmatter["user-invocable"] === false) return;
			const description = frontmatter.description.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim().slice(0, 240);
			if (!description) return;
			if (!full) return { name, description };
			const body = decoder.decode(buffer.subarray(headerLength, size)).trim();
			if (!body || body.includes("\0") || /!\s*`/.test(body)) return;
			return { name, body };
		} finally { closeSync(fd); }
	} catch { /* Invalid or concurrently changed skills are unavailable. */ }
}

// The host calls this only with its canonical Home. The worker uses its sandbox cwd.
export function discoverSkills(base, scope) {
	try {
		const location = roots(base, scope);
		const directory = opendirSync(location.root);
		const skills = [];
		let count = 0, entry;
		try {
			while (count++ < maxEntries && (entry = directory.readSync())) {
				if (!entry.isDirectory() || !validName(entry.name)) continue;
				const skill = readSkill(location, entry.name, false);
				if (skill) skills.push(skill);
			}
		} finally { directory.closeSync(); }
		skills.sort((a, b) => a.name.localeCompare(b.name));
		return { skills: skills.slice(0, maxCatalog), partial: count > maxEntries || skills.length > maxCatalog };
	} catch {
		return { skills: [], partial: false };
	}
}

export function loadSkill(base, scope, name) {
	if (!validName(name)) return;
	try { return readSkill(roots(base, scope), name, true); } catch { /* Missing or inaccessible root. */ }
}
