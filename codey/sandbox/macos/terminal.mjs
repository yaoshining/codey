// Lightweight terminal host for the opt-in macOS sandbox. No Pi CLI discovery.
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { createExtensionRuntime } from "../../../packages/coding-agent/src/core/extensions/loader.ts";
import { findInitialModel } from "../../../packages/coding-agent/src/core/model-resolver.ts";
import { createAgentSession } from "../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";
import { hostModel } from "./host-model.mjs";
import { openSeatbelt } from "./seatbelt.mjs";
import { toolDefinitions } from "./tools.mjs";

const help = `Usage: codey --sandbox workspace-write [--workspace <directory>] [--provider <name> --model <id>]

Open an interactive macOS session using the current files. Tools and !/!! commands
run in Seatbelt, without network. Model requests run on the host.
Supported terminal commands: /help, /quit, !command, !!command.`;
const loginGuidance = "Exit with /quit, run regular codey and use /login there, then reopen this sandbox.";
const noModel = `No models available. ${loginGuidance}`;

function display(value) {
	return stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function emptyResources() {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function terminal() {
	const { values } = parseArgs({
		options: {
			sandbox: { type: "string" },
			workspace: { type: "string" },
			provider: { type: "string" },
			model: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.sandbox !== "workspace-write") throw new Error(help);
	if (values.help) return console.log(help);
	if (process.platform !== "darwin") throw new Error("workspace-write requires macOS Seatbelt. No tool was run.");
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("An interactive Codey terminal is required. RPC/T3 is unavailable.");
	if (Boolean(values.provider) !== Boolean(values.model)) throw new Error("Specify --provider and --model together.");

	const workspace = realpathSync(resolve(values.workspace ?? process.cwd()));
	if (!lstatSync(workspace).isDirectory()) throw new Error("The workspace must be a directory.");
	const home = realpathSync(homedir());
	const sandbox = await openSeatbelt(workspace, home);
	let runtime;
	let session;
	try {
		const host = await hostModel(home, workspace, sandbox.hostDir);
		runtime = host.runtime;
		if (host.warning) console.error(host.warning);
		let model = values.provider && runtime.getModel(values.provider, values.model);
		if (values.provider && !model) throw new Error("The selected provider/model is unavailable.");
		if (model && !runtime.hasConfiguredAuth(model.provider)) {
			throw new Error(`Authentication is unavailable for "${model.provider}". ${loginGuidance}`);
		}
		const { defaultProvider, defaultModel, defaultThinkingLevel } = host.settings;
		if (!model) {
			const selection = await findInitialModel({
				scopedModels: [], isContinuing: false, defaultProvider, defaultModelId: defaultModel, modelRuntime: runtime,
			});
			model = selection.model;
		}
		const settings = SettingsManager.inMemory({ defaultProvider, defaultModel, defaultThinkingLevel, blockImages: true });
		const customTools = toolDefinitions(workspace).map((definition) => ({
			...definition,
			execute: async (_id, args, signal) => {
				const { content, isError } = await sandbox.execute(definition.name, args, signal);
				return { content, details: undefined, isError };
			},
		}));
		const result = await createAgentSession({
			cwd: workspace, agentDir: host.agentDir, modelRuntime: runtime, model: model || undefined,
			settingsManager: settings, resourceLoader: emptyResources(), sessionManager: SessionManager.inMemory(workspace),
			tools: customTools.map(({ name }) => name), customTools,
		});
		session = result.session;
		// The SDK's Agent can expose a placeholder even when model selection returned nothing.
		await readCommands(workspace, session, sandbox, model);
	} finally {
		session?.dispose();
		try {
			await runtime?.settleCredentialWrites();
		} finally {
			sandbox.close();
		}
	}
}

async function readCommands(workspace, session, sandbox, model) {
	console.log(`Codey macOS sandbox (workspace-write): ${display(workspace)}`);
	if (model) console.log(`Model: ${display(model.provider)}/${display(model.id)}`);
	else console.error(noModel);
	console.log("Tools are offline. Model requests use the host. Type /help or /quit.");
	const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "codey-sandbox> " });
	let active;
	input.on("SIGINT", () => {
		if (active) {
			active.abort();
			void session.abort();
		} else {
			input.close();
		}
	});
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(display(event.assistantMessageEvent.delta));
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.errorMessage) console.error(display(event.message.errorMessage));
			process.stdout.write("\n");
		}
	});
	try {
		input.prompt();
		for await (const line of input) {
			const text = line.trim();
			if (text === "/quit") break;
			active = new AbortController();
			try {
				if (text === "/help") console.log(help);
				else if (text === "/login" || text.startsWith("/login ")) console.log(loginGuidance);
				else if (text.startsWith("/") || text.startsWith("@")) console.log("This command or attachment is unavailable in the macOS sandbox.");
				else if (text.startsWith("!")) {
					const excludeFromContext = text.startsWith("!!");
					const command = text.slice(excludeFromContext ? 2 : 1).trim();
					if (command) {
						const result = await sandbox.execute("bash", { command }, active.signal);
						const output = result.content.map((entry) => entry.text).join("\n");
						console.log(display(output));
						session.recordBashResult(command, { output, exitCode: result.exitCode ?? 0, cancelled: false, truncated: false }, { excludeFromContext });
					}
				} else if (text) {
					if (model) await session.prompt(text, { expandPromptTemplates: false });
					else console.error(noModel);
				}
			} catch (error) {
				if (/^(Authentication failed for |No API key found for )/.test(error.message) && model) {
					console.error(`Authentication is unavailable for "${display(model.provider)}". ${loginGuidance}`);
				} else console.error(display(error.message));
			} finally {
				active = undefined;
			}
			input.prompt();
		}
	} finally {
		unsubscribe();
		input.close();
		await session.abort();
	}
}

try {
	await terminal();
} catch (error) {
	console.error(`Codey macOS sandbox: ${display(error.message)}`);
	process.exitCode = 1;
}
