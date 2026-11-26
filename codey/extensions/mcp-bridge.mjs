// Add a trusted, explicitly configured Node bridge to the normal MCP extension.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpNamespace, StdioTransport } from "@earendil-works/pi-mcp";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import { loadMcpConfig } from "../../packages/coding-agent/src/extensions/mcp/config.ts";
import { bridgeEndpoint, bridgeName, bridgeStore, bridgeTokenVariable, selectCertificate } from "./mcp-bridge-config.mjs";
import { loginBridge } from "./mcp-bridge-oauth.mjs";
import { bridgeOAuthStore, oauthStatePath } from "./mcp-bridge-oauth-store.mjs";

const bridgeEntry = Symbol("Codey MCP bridge");
const child = fileURLToPath(new URL("./mcp-bridge-child.mjs", import.meta.url));
const resolver = new URL("../../packages/coding-agent/src/experimental/source-resolver.ts", import.meta.url).href;

function regularConfig(ctx) {
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
}

export function loadWithBridges(ctx) {
	const config = regularConfig(ctx);
	try {
		const saved = bridgeStore(ctx.cwd, { optional: true })?.list();
		if (!saved) return config;
		config.errors.push(...saved.errors);
		const names = new Set(config.servers.map(({ name }) => mcpNamespace(name)));
		for (const bridge of saved.entries) {
			const namespace = mcpNamespace(bridge.name);
			if (names.has(namespace)) {
				config.errors.push(`MCP bridge "${bridge.name}" conflicts with another server and was skipped.`);
				continue;
			}
			config.servers.push({ name: bridge.name, scope: "extension", source: bridge.source,
				config: { command: process.execPath, args: [child] }, [bridgeEntry]: bridge });
			names.add(namespace);
		}
	} catch (error) {
		config.errors.push(`Could not load Codey MCP bridges: ${error.message}`);
	}
	return config;
}

export function createBridgeTransport(entry) {
	const bridge = entry[bridgeEntry];
	if (!bridge) return undefined;
	const token = bridge.tokenVariable && process.env[bridge.tokenVariable];
	if (bridge.tokenVariable && (!token || !/^[a-z0-9._~+/-]+=*$/i.test(token) || token.length > 8192)) {
		throw new Error(`Set ${bridge.tokenVariable} to a valid Bearer token before starting Codey.`);
	}
	return new StdioTransport({
		command: process.execPath, args: ["--import", resolver, child], cwd: dirname(child), inheritEnv: false,
		env: { CODEY_MCP_BRIDGE_URL: bridge.url, CODEY_MCP_BRIDGE_CA: bridge.pem,
			...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
			...(token ? { CODEY_MCP_BRIDGE_TOKEN: token } : { CODEY_MCP_BRIDGE_OAUTH_FILE: oauthStatePath(bridge) }) },
		stderr: "pipe", ...(token ? {} : { closeTimeoutMs: 20_000 }),
	});
}

async function manageBridges(pi, args, ctx) {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Manage Codey MCP bridges from the ordinary interactive terminal.", "warning");
		return;
	}
	try {
		const store = bridgeStore(ctx.cwd);
		const action = args.trim() || await ctx.ui.select("Codey MCP bridges", ["Add Node bridge", "Sign in to a Node bridge", "Sign out of a Node bridge", "List Node bridges", "Remove Node bridge"]);
		if (action === undefined) return;
		if (["login", "logout", "Sign in to a Node bridge", "Sign out of a Node bridge"].includes(action)) {
			const entries = store.list().entries.filter(({ tokenVariable }) => !tokenVariable);
			if (!entries.length) return ctx.ui.notify("Add a Node bridge without a fixed Bearer token before using OAuth.", "info");
			const selection = await ctx.ui.select("Choose the MCP bridge", entries.map(({ name }) => name));
			const bridge = entries.find(({ name }) => name === selection);
			if (!bridge) return;
			if (action === "logout" || action === "Sign out of a Node bridge") {
				if (!await ctx.ui.confirm("Remove this bridge's saved OAuth grant?", `${bridge.name}\n${bridge.url}`)) return;
				const credentials = bridgeOAuthStore(oauthStatePath(bridge));
				await credentials.locked(() => credentials.remove());
				ctx.ui.notify("MCP bridge sign-in removed. Restart Codey or use /reload.", "info");
				return;
			}
			try {
				const isCurrent = () => store.list().entries.some(({ name, url, pem, tokenVariable }) =>
					name === bridge.name && url === bridge.url && pem === bridge.pem && !tokenVariable);
				if (await loginBridge(bridge, ctx.ui, isCurrent)) ctx.ui.notify("MCP bridge signed in. Restart Codey or use /reload.", "info");
			} catch (error) {
				if (error.name === "McpSignInCancelledError") ctx.ui.notify("MCP bridge sign-in cancelled.", "info");
				else ctx.ui.notify("MCP bridge sign-in stopped. Check the certificate, OAuth metadata and whether the browser approved access.", "error");
			}
			return;
		}
		if (action === "list" || action === "List Node bridges") {
			const { entries, errors } = store.list();
			ctx.ui.notify([...entries.map(({ name, url }) => `${name}: ${url}`), ...errors].join("\n") || "No MCP bridges saved.", "info");
			return;
		}
		if (action === "remove" || action === "Remove Node bridge") {
			const input = await ctx.ui.input("Remove MCP bridge by name");
			if (input === undefined) return;
			const name = bridgeName(input.trim());
			if (!await ctx.ui.confirm("Remove saved Node bridge?", `${name}\nRestart Codey or use /reload to close any active connection.`)) return;
			const bridge = store.list().entries.find((entry) => entry.name === name);
			if (bridge && !bridge.tokenVariable) {
				const credentials = bridgeOAuthStore(oauthStatePath(bridge));
				await credentials.locked(() => { credentials.remove(); store.remove(name); });
			} else store.remove(name);
			ctx.ui.notify("MCP bridge removed. Restart Codey or use /reload.", "info");
			return;
		}
		if (action !== "add" && action !== "Add Node bridge") {
			ctx.ui.notify("Usage: /mcp bridge [add|login|logout|list|remove]", "warning");
			return;
		}
		const nameInput = await ctx.ui.input("New MCP bridge name");
		if (nameInput === undefined) return;
		const name = bridgeName(nameInput.trim());
		function conflicts() {
			return [...regularConfig(ctx).servers, ...pi.getMcpServers(), ...store.list().entries]
				.some((entry) => mcpNamespace(entry.name) === mcpNamespace(name));
		}
		if (conflicts()) throw new Error("An MCP server or bridge already uses that name.");
		const endpoint = await ctx.ui.input("HTTPS MCP endpoint (no credentials or query)");
		if (endpoint === undefined) return;
		const url = bridgeEndpoint(endpoint.trim());
		const standard = "Use Node and system trust";
		const privateCa = "Choose a verified public PEM for this endpoint";
		const tlsTrust = await ctx.ui.select("TLS trust for this bridge", [standard, privateCa]);
		if (!tlsTrust) return;
		let pem = "";
		let verified = standard;
		if (tlsTrust === privateCa) {
			const certificate = await ctx.ui.input("Absolute path to the verified public certificate PEM");
			if (certificate === undefined) return;
			const selected = selectCertificate(certificate.trim());
			pem = selected.pem;
			verified = `Certificate SHA-256: ${selected.fingerprint}`;
		}
		const tokenInput = await ctx.ui.input("Optional Bearer token environment variable name (blank for none)");
		if (tokenInput === undefined) return;
		const tokenVariable = bridgeTokenVariable(tokenInput.trim());
		const trust = "Trust and save this endpoint";
		if (await ctx.ui.select([
			"Save this MCP bridge?", `Server: ${name}`, `Endpoint: ${url}`, verified,
			`Bearer token: ${tokenVariable ? `from ${tokenVariable}` : "none"}`,
			...(pem ? ["Verify the fingerprint with your administrator."] : []),
			"The bridge applies only to this endpoint and is saved in ~/.codey/agent/mcp-bridges.",
		].join("\n"), ["Cancel", trust], { blockedKind: "permission" }) !== trust) return;
		if (conflicts()) throw new Error("An MCP server or bridge already uses that name.");
		store.add(name, { url, pem, tokenVariable });
		ctx.ui.notify("MCP bridge saved. Restart Codey or use /reload, then open /mcp.", "info");
	} catch (error) {
		ctx.ui.notify(error.code === "EEXIST" ? "An MCP bridge already uses that name." : `MCP bridge: ${error.message}`, "error");
	}
}

export function withBridgeCommands(factory) {
	return (pi) => factory({ ...pi, registerCommand(name, command) {
		if (name !== "mcp") return pi.registerCommand(name, command);
		return pi.registerCommand(name, {
			...command,
			description: `${command.description}; use /mcp bridge for local Node bridges`,
			getArgumentCompletions(prefix) {
				const base = command.getArgumentCompletions?.(prefix) ?? [];
				const input = prefix.trimStart();
				if (input === "bridge") return null;
				if ("bridge".startsWith(input)) return [...base, { value: "bridge", label: "bridge", description: "Manage local Node MCP bridges" }];
				if (!input.startsWith("bridge ")) return base.length ? base : null;
				const actionPrefix = input.slice(7);
				return ["add", "login", "logout", "list", "remove"].filter((action) => action !== actionPrefix && action.startsWith(actionPrefix))
					.map((action) => ({ value: `bridge ${action}`, label: action }));
			},
			handler(args, ctx) {
				const text = args.trim();
				const bridge = /^bridge(?:\s+([\s\S]*))?$/.exec(text);
				return bridge ? manageBridges(pi, bridge[1] ?? "", ctx) : command.handler(args, ctx);
			},
		});
	} });
}
