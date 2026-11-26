// Add direct HTTPS servers with user-confirmed endpoint trust and scoped OAuth.
import { McpAuthRequiredError, McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { parseWwwAuthenticate } from "@earendil-works/pi-mcp/oauth";
import { Agent, fetch } from "undici";
import { bridgeEndpoint, bridgeName, bridgeNamespace, bridgeStore } from "./mcp-bridge-config.mjs";
import { loadWithBridges } from "./mcp-bridge.mjs";
import { bridgeOAuthAuth, loginBridge } from "./mcp-bridge-oauth.mjs";
import { bridgeOAuthStore, oauthStatePath } from "./mcp-bridge-oauth-store.mjs";
import { confirmCertificate, defaultDirectTls, directTlsError, discoverCertificate, pinnedTls } from "./mcp-direct-tls.mjs";

const directEntry = Symbol("Codey direct HTTPS MCP");
const directStore = (ctx, optional = false) => bridgeStore(ctx.cwd, { direct: true, optional });
const tlsOptions = (record) => record.pem ? pinnedTls(new URL(record.url), record.pem) : defaultDirectTls();

export function loadWithDirectMcp(ctx) {
	const config = loadWithBridges(ctx);
	try {
		const saved = directStore(ctx, true)?.list();
		if (!saved) return config;
		config.errors.push(...saved.errors);
		const names = new Set(config.servers.map(({ name }) => bridgeNamespace(name)));
		for (const record of saved.entries) {
			const namespace = bridgeNamespace(record.name);
			if (names.has(namespace)) {
				config.errors.push(`Direct HTTPS MCP server "${record.name}" conflicts with an existing server and was skipped.`);
				continue;
			}
			// Declare transport-owned authentication to Pi. The custom transport supplies its own
			// credentials and never sends the marker header or invokes Pi's separate OAuth client.
			config.servers.push({ name: record.name, source: record.source, scope: "extension", [directEntry]: record,
				config: { url: record.url, headers: { Authorization: "" } } });
			names.add(namespace);
		}
	} catch (error) {
		config.errors.push(`Could not load saved direct HTTPS MCP servers: ${error.message}`);
	}
	return config;
}

function directTransport(record, authProvider, probe = false) {
	const dispatcher = new Agent({ connect: tlsOptions(record) });
	const transport = new StreamableHttpTransport({
		url: record.url, authProvider,
		async fetch(input, init) {
			const url = new URL(input);
			if (url.href !== record.url) throw new Error("The MCP request left the configured endpoint.");
			const signal = probe ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : init.signal;
			try {
				return await fetch(url, { ...init, signal, dispatcher, redirect: "error" });
			} catch (error) {
				throw directTlsError(error, Boolean(record.pem));
			}
		},
	});
	const close = transport.close.bind(transport);
	transport.close = async () => {
		try { await close(); } finally { await dispatcher.destroy(); }
	};
	return transport;
}

export function createDirectTransport(entry) {
	const record = entry[directEntry];
	if (!record) return;
	const auth = bridgeOAuthAuth(new URL(record.url), record.pem, oauthStatePath(record), () => {}, tlsOptions(record));
	const guidance = `Run /mcp direct login ${record.name} to sign in to this HTTPS MCP server.`;
	return directTransport(record, {
		async token() {
			try { return await auth.token(); } catch { throw new Error(guidance); }
		},
		async onUnauthorized(context) {
			try { await auth.onUnauthorized(context); } catch { throw new Error(guidance); }
		},
	});
}

async function probeService(record) {
	const client = new McpClient({ name: "Codey", version: "1", requestTimeoutMs: 10_000 });
	try {
		await client.connect(directTransport(record, undefined, true));
	} catch (error) {
		if (error instanceof McpAuthRequiredError) return parseWwwAuthenticate(error.wwwAuthenticate);
		throw new Error("Could not initialize the HTTPS MCP endpoint. Check the URL and server status.");
	} finally {
		await client.close();
	}
}

async function signIn(record, challenge, ctx, store) {
	const isCurrent = () => store.list().entries.some(({ name, url, pem }) =>
		name === record.name && url === record.url && pem === record.pem);
	try {
		return await loginBridge(record, ctx.ui, isCurrent, { directTls: tlsOptions(record), challenge });
	} catch (error) {
		if (error.name !== "McpSignInCancelledError") {
			ctx.ui.notify("Sign-in could not finish. Check the OAuth service and certificate trust, including the browser's own TLS trust.", "error");
		}
		return false;
	}
}

async function addDirect(pi, ctx, store) {
	const input = await ctx.ui.input("New direct HTTPS MCP server name");
	if (input === undefined) return;
	const name = bridgeName(input.trim());
	const conflicts = () => [...loadWithDirectMcp(ctx).servers, ...pi.getMcpServers()]
		.some((entry) => bridgeNamespace(entry.name) === bridgeNamespace(name));
	if (conflicts()) throw new Error("An MCP server already uses that name.");
	const endpoint = await ctx.ui.input("HTTPS MCP endpoint (no credentials or query)");
	if (endpoint === undefined) return;
	const url = new URL(bridgeEndpoint(endpoint.trim()));
	const candidate = await discoverCertificate(url);
	if (candidate) {
		const approve = "Fingerprint matches — trust and add this service";
		if (await ctx.ui.select([
			"Verify the self-signed MCP certificate",
			`Endpoint: ${url.href}`, `SHA-256: ${candidate.fingerprint}`,
			"Compare this fingerprint with a trusted source, such as your NAS administration console.",
			"Approval applies to this service's exact MCP URL and its same-origin OAuth requests.",
		].join("\n"), ["Cancel", approve], { blockedKind: "permission" }) !== approve) return;
		await confirmCertificate(url, candidate.pem);
	}
	const record = { name, url: url.href, pem: candidate?.pem ?? "" };
	const challenge = await probeService(record);
	if (conflicts()) throw new Error("An MCP server already uses that name.");
	store.add(name, { url: record.url, pem: record.pem });
	const saved = store.list().entries.find((entry) => entry.name === name);
	const open = "Open browser to sign in";
	const signedIn = challenge && await ctx.ui.select(`Added "${name}". Its MCP endpoint requires authentication.`, ["Later", open]) === open &&
		await signIn(saved, challenge, ctx, store);
	ctx.ui.notify(signedIn ? `Added and signed in to "${name}".`
		: challenge ? `Added "${name}". Run /mcp direct login ${name} when ready to sign in.` : `Added direct HTTPS MCP server "${name}".`, "info");
	await ctx.reload();
}

async function manageDirect(pi, ctx, action, requested) {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Manage direct HTTPS MCP servers in the interactive Codey terminal.", "warning");
		return;
	}
	try {
		const store = directStore(ctx);
		if (action === "add") return await addDirect(pi, ctx, store);
		const saved = store.list().entries;
		if (!saved.length) return ctx.ui.notify("No saved direct HTTPS MCP servers.", "info");
		const selection = requested ?? await ctx.ui.select("Choose a direct HTTPS MCP server", saved.map(({ name }) => name));
		if (!selection) return;
		const record = saved.find(({ name }) => name.toLowerCase() === selection.toLowerCase());
		if (!record) throw new Error("No saved direct HTTPS MCP server has that name.");
		if (action === "login") {
			const challenge = await probeService(record);
			if (!challenge) return ctx.ui.notify("This MCP endpoint did not request authentication.", "info");
			if (!await signIn(record, challenge, ctx, store)) return;
		} else {
			const remove = action === "remove";
			const confirm = remove ? "Remove service and its saved trust" : "Sign out of this service";
			if (await ctx.ui.select(`${record.name}\n${record.url}`, ["Cancel", confirm], { blockedKind: "permission" }) !== confirm) return;
			const grant = bridgeOAuthStore(oauthStatePath(record));
			await grant.locked(() => {
				grant.remove();
				if (remove) store.remove(record.name);
			});
		}
		ctx.ui.notify(action === "login" ? `Signed in to "${record.name}".` :
			action === "remove" ? `Removed "${record.name}".` : `Signed out of "${record.name}".`, "info");
		await ctx.reload();
	} catch (error) {
		ctx.ui.notify(`Direct HTTPS MCP: ${error.message}`, "error");
	}
}

export function withDirectCommands(factory) {
	return (pi) => factory({ ...pi, registerCommand(name, command) {
		if (name !== "mcp") return pi.registerCommand(name, command);
		return pi.registerCommand(name, {
			...command,
			description: `${command.description}; use /mcp add for direct HTTPS servers`,
			getArgumentCompletions(prefix) {
				const input = prefix.trimStart();
				const base = command.getArgumentCompletions?.(prefix) ?? [];
				if (input.startsWith("direct ")) {
					const action = input.slice(7);
					return ["login", "logout", "remove"].filter((item) => item !== action && item.startsWith(action))
						.map((item) => ({ value: `direct ${item}`, label: item }));
				}
				const items = [...base, ...["add", "direct "].filter((item) => item !== input && item.startsWith(input))
					.map((item) => ({ value: item, label: item.trim() }))];
				return items.length ? items : null;
			},
			async handler(args, ctx) {
				const input = args.trim();
				if (input === "add") return manageDirect(pi, ctx, "add");
				const direct = /^direct\s+(login|logout|remove)(?:\s+(\S+))?$/.exec(input);
				if (direct) return manageDirect(pi, ctx, direct[1], direct[2]);
				if (!input && ctx.mode === "tui" && ctx.hasUI) {
					const manage = "Manage MCP servers";
					const add = "Add direct HTTPS server";
					const login = "Sign in to a direct HTTPS server";
					const bridges = "Manage local Node bridges";
					const choice = await ctx.ui.select("Codey MCP", [manage, add, login, bridges]);
					if (choice === add) return manageDirect(pi, ctx, "add");
					if (choice === login) return manageDirect(pi, ctx, "login");
					if (choice === bridges) return command.handler("bridge", ctx);
					if (choice !== manage) return;
				}
				return command.handler(args, ctx);
			},
		});
	} });
}
