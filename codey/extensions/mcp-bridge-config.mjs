// Store only explicit user-approved endpoints and public certificates outside the project.
import { X509Certificate } from "node:crypto";
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";

const maxConfigBytes = 48 * 1024;
const safeName = /^[a-z][a-z0-9_-]{0,39}$/;

function owned(stat) {
	return (process.getuid === undefined || process.getuid() === stat.uid) && !(stat.mode & 0o022);
}

function readSmallFile(path, requireOwner) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > maxConfigBytes || (requireOwner && !owned(stat))) {
			throw new Error("Select a small, regular certificate file. Saved bridge settings must be user-owned and protected from other writers.");
		}
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

export function selectCertificate(path) {
	if (!isAbsolute(path)) throw new Error("Enter an absolute path to the public PEM file.");
	return validateCertificate(readSmallFile(path, false));
}

function validateCertificate(value) {
	const pem = value.trim();
	if (Buffer.byteLength(pem) > 16 * 1024 || !/^-----BEGIN CERTIFICATE-----[\r\n]+[a-z0-9+/=\r\n]+-----END CERTIFICATE-----$/i.test(pem)) {
		throw new Error("The PEM must contain one public certificate and no private key.");
	}
	let certificate;
	try { certificate = new X509Certificate(pem); } catch { throw new Error("The PEM does not contain a valid public certificate."); }
	return { pem, fingerprint: certificate.fingerprint256 };
}

export function bridgeEndpoint(value) {
	let url;
	try { url = new URL(value); } catch { throw new Error("Enter a complete HTTPS MCP URL."); }
	if (!/^https:\/\//i.test(value) || url.protocol !== "https:" || url.username || url.password || /[\x00-\x20\x7f\\?#]/.test(value) || value.length > 2048) {
		throw new Error("Enter an HTTPS MCP URL without URL credentials, query, or fragment.");
	}
	return url.href;
}

export function bridgeName(value) {
	if (!safeName.test(value)) throw new Error("Start the MCP bridge name with a lowercase letter and use up to 40 letters, digits, underscores or hyphens.");
	return value;
}

export function bridgeTokenVariable(value) {
	if (value && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(value)) throw new Error("Use an uppercase environment variable name for the optional Bearer token.");
	return value;
}

export function bridgeStore(cwd, { optional = false } = {}) {
	const codey = join(realpathSync(homedir()), ".codey");
	const agent = join(codey, "agent");
	const folder = join(agent, "mcp-bridges");
	const rel = relative(realpathSync(cwd), agent);
	if (getAgentDir() !== agent || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) {
		if (optional) return undefined;
		throw new Error("MCP bridges require the default ~/.codey/agent outside the current project directory.");
	}
	function directory(create) {
		for (const path of [codey, agent, folder]) {
			if (create) {
				try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
			}
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (!stat) return false;
			if (!stat.isDirectory() || !owned(stat)) throw new Error("MCP bridge settings require user-owned directories protected from other writers.");
		}
		return true;
	}
	return {
		list() {
			const entries = [], errors = [];
			if (!directory(false)) return { entries, errors };
			for (const file of readdirSync(folder).sort()) {
				const name = file.slice(0, -5);
				if (!file.endsWith(".json") || !safeName.test(name)) continue;
				try {
					const source = join(folder, file);
					const value = JSON.parse(readSmallFile(source, true));
					const url = bridgeEndpoint(value.url);
					const pem = value.pem === undefined || value.pem === "" ? "" : validateCertificate(value.pem).pem;
					entries.push({ name, url, pem, tokenVariable: bridgeTokenVariable(value.tokenVariable ?? ""), source });
				} catch {
					errors.push(`Could not read saved MCP bridge "${name}". Check its configuration or remove it with /mcp bridge remove.`);
				}
			}
			return { entries, errors };
		},
		add(name, value) {
			directory(true);
			const temp = mkdtempSync(join(folder, ".new-"));
			try {
				const pending = join(temp, "config");
				writeFileSync(pending, `${JSON.stringify(value, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
				linkSync(pending, join(folder, `${bridgeName(name)}.json`));
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		},
		remove(name) {
			if (!directory(false)) throw new Error("There are no saved MCP bridges.");
			unlinkSync(join(folder, `${bridgeName(name)}.json`));
		},
	};
}
