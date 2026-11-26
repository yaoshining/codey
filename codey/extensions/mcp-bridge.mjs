// Add a trusted, explicitly configured Node bridge to the normal MCP extension.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpNamespace, StdioTransport } from "@earendil-works/pi-mcp";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import { loadMcpConfig } from "../../packages/coding-agent/src/extensions/mcp/config.ts";
import { bridgeEndpoint, bridgeName, bridgeStore, bridgeTokenVariable, selectCertificate } from "./mcp-bridge-config.mjs";

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
		env: { CODEY_MCP_BRIDGE_URL: bridge.url, CODEY_MCP_BRIDGE_CA: bridge.pem, ...(token ? { CODEY_MCP_BRIDGE_TOKEN: token } : {}) },
		stderr: "pipe",
	});
}

async function manageBridges(pi, args, ctx) {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Manage Codey MCP bridges from the ordinary interactive terminal.", "warning");
		return;
	}
	try {
		const store = bridgeStore(ctx.cwd);
		const action = args.trim() || await ctx.ui.select("Codey MCP bridges", ["Add Node bridge", "List Node bridges", "Remove Node bridge"]);
		if (action === undefined) return;
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
			store.remove(name);
			ctx.ui.notify("MCP bridge removed. Restart Codey or use /reload.", "info");
			return;
		}
		if (action !== "add" && action !== "Add Node bridge") {
			ctx.ui.notify("Usage: /mcp bridge [add|list|remove]", "warning");
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
		const certificate = await ctx.ui.input("Absolute path to the verified public certificate PEM");
		if (certificate === undefined) return;
		const { pem, fingerprint } = selectCertificate(certificate.trim());
		const tokenInput = await ctx.ui.input("Optional Bearer token environment variable name (blank for none)");
		if (tokenInput === undefined) return;
		const tokenVariable = bridgeTokenVariable(tokenInput.trim());
		const trust = "Trust and save this endpoint";
		if (await ctx.ui.select([
			"Trust this certificate for one MCP bridge?", `Server: ${name}`, `Endpoint: ${url}`, `Certificate SHA-256: ${fingerprint}`,
			`Bearer token: ${tokenVariable ? `from ${tokenVariable}` : "none"}`,
			"Verify the fingerprint with your administrator. The grant applies only to this endpoint and is saved in ~/.codey/agent/mcp-bridges.",
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
				return ["add", "list", "remove"].filter((action) => action !== actionPrefix && action.startsWith(actionPrefix))
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
