// Add user-owned, endpoint-specific TLS trust to Codey's in-session MCP transport.
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { X509Certificate } from "node:crypto";
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { Agent, fetch } from "undici";
import { resolveHeadersOrThrow } from "../../packages/coding-agent/src/core/resolve-config-value.ts";
import { createMcpExtension } from "../../packages/coding-agent/src/extensions/mcp/index.ts";
import { createDefaultTransport } from "../../packages/coding-agent/src/extensions/mcp/runtime.ts";
import { createBridgeTransport, loadWithBridges, withBridgeCommands } from "./mcp-bridge.mjs";

function safelyOwned(stat) {
	return (process.getuid === undefined || stat.uid === process.getuid()) && !(stat.mode & 0o022);
}

function inside(parent, child) {
	const rel = relative(parent, child);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function readTrusted(path, optional = false) {
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (optional && error.code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || !safelyOwned(stat) || stat.size > 128 * 1024) {
			throw new Error("MCP CA files must be small, user-owned regular files without group or public write access.");
		}
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

function trustedDirectory(path) {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return false;
	if (!stat.isDirectory() || !safelyOwned(stat)) throw new Error("MCP CA settings require user-owned directories without group or public write access.");
	return true;
}

function configuredCa(entry, cwd, url) {
	if (entry.scope !== "global") return;
	const codey = join(realpathSync(homedir()), ".codey");
	const agent = join(codey, "agent");
	// Keep authority in the default host directory, even if Pi's effective config was redirected.
	if (entry.source !== join(agent, "mcp.json") || inside(realpathSync(cwd), agent)) return;
	const path = join(agent, "mcp-ca.json");
	if (!lstatSync(path, { throwIfNoEntry: false })) return;
	if (!trustedDirectory(codey) || !trustedDirectory(agent)) return;
	const globalConfig = lstatSync(entry.source);
	if (!globalConfig.isFile() || !safelyOwned(globalConfig)) throw new Error("MCP CA settings require a user-owned regular global mcp.json without group or public write access.");
	const raw = readTrusted(path, true);
	if (raw === undefined) return;
	const settings = JSON.parse(raw);
	if (!settings || Array.isArray(settings) || typeof settings !== "object") throw new Error("mcp-ca.json must contain a JSON object.");
	if (!Object.hasOwn(settings, entry.name)) return;
	const selected = settings[entry.name];
	if (typeof selected?.url !== "string" || new URL(selected.url).href !== url.href || url.protocol !== "https:" || url.username || url.password) {
		throw new Error("The MCP CA URL in mcp-ca.json must match the global server's HTTPS endpoint exactly.");
	}
	if (typeof selected.caFile !== "string" || !/^[a-z0-9][a-z0-9_.-]*\.pem$/i.test(selected.caFile)) {
		throw new Error("The MCP CA caFile must be a PEM filename in ~/.codey/agent/mcp-cas.");
	}
	const certs = join(agent, "mcp-cas");
	if (!trustedDirectory(certs)) throw new Error("The ~/.codey/agent/mcp-cas directory is missing.");
	const pem = readTrusted(join(certs, selected.caFile)).trim();
	if (!/^-----BEGIN CERTIFICATE-----[\r\n]+[a-z0-9+/=\r\n]+-----END CERTIFICATE-----$/i.test(pem)) {
		throw new Error("The MCP CA PEM must contain one public certificate.");
	}
	new X509Certificate(pem);
	return pem;
}

function tlsError(error, url, hasCa) {
	for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
		if (cause.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
			return new Error(`MCP TLS identity mismatch for ${url.hostname}. The certificate SAN must match the URL's hostname or IP address.`, { cause: error });
		}
		if (["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(cause.code)) {
			const guidance = hasCa ? "Verify the configured CA and the server's certificate chain."
				: "For a global server in Codey, configure a CA you verified independently in ~/.codey/agent/mcp-ca.json.";
			return new Error(`MCP TLS certificate is untrusted for ${url.hostname}. ${guidance}`, { cause: error });
		}
		if (["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"].includes(cause.code)) {
			return new Error(`MCP TLS certificate is expired or not yet valid for ${url.hostname}.`, { cause: error });
		}
	}
	return error;
}

export const codeyMcp = withBridgeCommands(createMcpExtension({
	loadConfig: loadWithBridges,
	createTransport(entry, cwd, authProvider) {
		const bridge = createBridgeTransport(entry);
		if (bridge) return bridge;
		const { config, name } = entry;
		if (!("url" in config)) return createDefaultTransport(entry, cwd, authProvider);
		const url = new URL(config.url);
		const ca = configuredCa(entry, cwd, url);
		const dispatcher = ca && new Agent({ connect: { ca, rejectUnauthorized: true } });
		const transport = new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			authProvider,
			async fetch(input, init) {
				const destination = new URL(input);
				const scoped = dispatcher && destination.href === url.href;
				try {
					return scoped ? await fetch(destination, { ...init, dispatcher, redirect: "error" })
						: await globalThis.fetch(input, init);
				} catch (error) {
					throw tlsError(error, destination, Boolean(scoped));
				}
			},
		});
		if (dispatcher) {
			const close = transport.close.bind(transport);
			transport.close = async () => {
				try { await close(); } finally { await dispatcher.destroy(); }
			};
		}
		return transport;
	},
}));
