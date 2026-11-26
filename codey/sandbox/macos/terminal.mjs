// Lightweight terminal host for the opt-in macOS sandbox. No Pi CLI discovery.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { createExtensionRuntime } from "../../../packages/coding-agent/src/core/extensions/loader.ts";
import { findInitialModel } from "../../../packages/coding-agent/src/core/model-resolver.ts";
import { createAgentSession } from "../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";
import { takeOverStdout } from "../../../packages/coding-agent/src/core/output-guard.ts";
import { styleInfo, styleReviewMarker } from "../../branding.mjs";
import { reviewSystemPrompt } from "../../extensions/review.mjs";
import { runSandboxAcp } from "./acp.mjs";
import { hostModel } from "./host-model.mjs";
import { httpsReadTool } from "./https-read.mjs";
import { projectDomains } from "./project-domains.mjs";
import { openSeatbelt } from "./seatbelt.mjs";
import { runSandboxRpc } from "./rpc.mjs";
import { toolDefinitions } from "./tools.mjs";
import { worktreeMenu } from "./worktree-menu.mjs";

const help = `Usage: codey --sandbox workspace-write [--workspace <directory>] [--provider <name> --model <id>]
       codey --sandbox workspace-write --mode rpc [--workspace <directory>] [--no-session]
       codey --sandbox workspace-write [--workspace <directory>] --list-domains
       codey --sandbox workspace-write [--workspace <directory>] --allow-domain <hostname>
       codey --sandbox workspace-write [--workspace <directory>] --remove-domain <hostname>

Open an interactive macOS session using the current files. Shell and file tools
run offline in Seatbelt. A model can request one HTTPS read for your approval.
Model requests run on the host.
Supported terminal commands: /review, /worktree, /help, /quit, !command, !!command.`;
const loginGuidance = "Exit with /quit, run regular codey and use /login there, then reopen this sandbox.";
const noModel = `No models available. ${loginGuidance}`;

function display(value) {
	return stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function terminalApproval(input, workspace, closed) {
	let pending = false;
	return async (url, signal) => {
		if (pending || closed.aborted || signal?.aborted) return false;
		pending = true;
		const answer = `approve ${randomBytes(4).toString("hex")}`;
		const signals = [closed, AbortSignal.timeout(30_000)];
		if (signal) signals.push(signal);
		const decision = AbortSignal.any(signals);
		try {
			console.log(`\nNetwork approval requested\nOperation: HTTPS GET ${url}\nWorking directory: ${JSON.stringify(workspace)}\nDestination: ${new URL(url).host}:443`);
			const reply = await input.question(`Type ${answer} to allow this request once, or press Enter to deny: `, { signal: decision });
			return !decision.aborted && reply === answer;
		} catch (error) {
			if (!decision.aborted) throw error;
			return false;
		} finally {
			pending = false;
		}
	};
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

async function launch() {
	const acp = process.env.CODEY_ACP_ENTRY === "1";
	const { values } = parseArgs({
		options: {
			sandbox: { type: "string" },
			workspace: { type: "string" },
			mode: { type: "string" },
			session: { type: "string" },
			"no-session": { type: "boolean" },
			"no-tools": { type: "boolean" },
			"no-extensions": { type: "boolean" },
			"no-approve": { type: "boolean" },
			offline: { type: "boolean" },
			extension: { type: "string", multiple: true },
			provider: { type: "string" },
			model: { type: "string" },
			"list-domains": { type: "boolean" },
			"allow-domain": { type: "string" },
			"remove-domain": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (acp) {
		const acpHelp = "Usage: codey acp --sandbox=workspace-write [--workspace <directory>] [--provider <name> --model <id>]";
		if (values.help) return console.log(acpHelp);
		if (values.sandbox !== "workspace-write") throw new Error(acpHelp);
		if (Object.keys(values).some((key) => !["sandbox", "workspace", "provider", "model"].includes(key))) {
			throw new Error("Unsupported option for Codey ACP.");
		}
	}
	if (values.sandbox !== "workspace-write") throw new Error(help);
	if (values.help) return console.log(help);
	const rpc = values.mode === "rpc";
	if (values.mode !== undefined && !rpc) throw new Error("Only --mode rpc is supported with workspace-write.");
	const rpcOnly = ["session", "no-session", "no-tools", "no-extensions", "no-approve", "offline", "extension"];
	if (!rpc && rpcOnly.some((flag) => values[flag] !== undefined)) throw new Error("RPC launch options require --mode rpc.");
	if (values.session !== undefined && values["no-session"]) throw new Error("Choose a saved sandbox session or --no-session.");
	if (values.extension && (process.env.CODEY_SANDBOX_T3 !== "1" ||
		values.extension.length !== 1 || basename(values.extension[0]) !== "pi-t3-mcp-extension.ts")) {
		throw new Error("Extensions are unavailable in the macOS sandbox.");
	}
	const wireWrite = rpc || acp ? process.stdout.write.bind(process.stdout) : undefined;
	if (rpc || acp) takeOverStdout();
	const management = [values["list-domains"], values["allow-domain"], values["remove-domain"]]
		.filter((value) => value !== undefined).length;
	if (management > 1 || (management && (rpc || values.provider !== undefined || values.model !== undefined))) {
		throw new Error("Choose one project domain action without model options.");
	}
	if (management) {
		const workspace = realpathSync(resolve(values.workspace ?? process.cwd()));
		if (!lstatSync(workspace).isDirectory()) throw new Error("The workspace must be a directory.");
		const domains = projectDomains(realpathSync(homedir()), workspace);
		if (values["list-domains"]) {
			const entries = domains.list();
			console.log(entries.length ? entries.join("\n") : "No HTTPS domains allowed for this workspace.");
		} else if (values["allow-domain"] !== undefined) {
			console.log(`Allowed HTTPS reads for ${domains.change("add", values["allow-domain"])} in ${JSON.stringify(workspace)}.`);
		} else {
			console.log(`Removed HTTPS permission for ${domains.change("remove", values["remove-domain"])} in ${JSON.stringify(workspace)}.`);
		}
		return;
	}
	if (process.platform !== "darwin") throw new Error("workspace-write requires macOS Seatbelt. No tool was run.");
	if (!rpc && !acp && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("An interactive Codey terminal is required. Use --mode rpc for JSONL.");
	if (Boolean(values.provider) !== Boolean(values.model)) throw new Error("Specify --provider and --model together.");

	const home = realpathSync(homedir());
	let hostDir;
	let runtime;
	let input;
	let initial;
	const startup = new AbortController();
	const startupSignals = rpc ? ["SIGTERM", "SIGINT", "SIGHUP"] : [];
	const cancelStartup = () => startup.abort();
	const finishedStartup = () => {
		for (const signal of startupSignals) process.off(signal, cancelStartup);
	};
	for (const signal of startupSignals) process.on(signal, cancelStartup);
	async function prepare(metadataOnly, signal) {
		let workspace;
		if (!metadataOnly) {
			workspace = realpathSync(resolve(values.workspace ?? process.cwd()));
			if (!lstatSync(workspace).isDirectory()) throw new Error("The workspace must be a directory.");
			initial = await openSeatbelt(workspace, home, signal);
		}
		hostDir = mkdtempSync("/private/tmp/codey-sandbox-model-");
		// Even ambient credential checks must not resolve relative paths from the probe caller's cwd.
		if (metadataOnly) process.chdir(hostDir);
		const host = await hostModel(home, workspace, hostDir);
		runtime = host.runtime;
		signal.throwIfAborted();
		if (host.warning) console.error(host.warning);
		let model = values.provider && runtime.getModel(values.provider, values.model);
		if (values.provider && !model) throw new Error("The selected provider/model is unavailable.");
		// An explicit selection can arrive while a newly registered provider's auth
		// snapshot is being published. Confirm it through the underlying auth check.
		if (model && !runtime.hasConfiguredAuth(model.provider) &&
			!await runtime.checkAuth(model.provider, { signal })) {
			throw new Error(`Authentication is unavailable for "${model.provider}". ${loginGuidance}`);
		}
		const { defaultProvider, defaultModel, defaultThinkingLevel } = host.settings;
		if (!model) {
			const selection = await findInitialModel({
				scopedModels: [], isContinuing: false, defaultProvider, defaultModelId: defaultModel, modelRuntime: runtime,
			});
			model = selection.model;
		}
		const { managedProviders } = host;
		if (metadataOnly) return { runtime, model, defaultThinkingLevel, managedProviders };
		const newSession = (cwd, sandbox, sessionManager, currentModel, extras = []) => {
			const settingsManager = SettingsManager.inMemory({
				defaultProvider, defaultModel, defaultThinkingLevel, blockImages: true,
				...((rpc || acp) ? { compaction: { enabled: false }, retry: { enabled: false } } : {}),
			});
			const customTools = values["no-tools"] ? [] : toolDefinitions(cwd).map((definition) => ({
				...definition,
				execute: async (_id, args, signal) => {
					const { content, isError } = await sandbox.execute(definition.name, args, signal);
					return { content, details: undefined, isError };
				},
			}));
			customTools.push(...extras);
			return createAgentSession({
				cwd, agentDir: host.agentDir, modelRuntime: runtime, model: currentModel || undefined,
				settingsManager, resourceLoader: emptyResources(), sessionManager,
				tools: customTools.map(({ name }) => name), customTools,
			});
		};
		return { workspace, runtime, model, newSession, defaultThinkingLevel, managedProviders,
			...(acp ? { runProjectSkill: initial.execute } : {}),
			createSession: (manager, currentModel) => newSession(workspace, initial, manager, currentModel) };
	}
	try {
		if (acp) return await runSandboxAcp({ home, prepare, wireWrite });
		const { workspace, model, newSession } = await prepare(false, startup.signal);
		if (rpc) {
			startup.signal.throwIfAborted();
			finishedStartup();
			if (values.extension) console.error("Codey macOS sandbox: T3's injected extension is disabled.");
			return await runSandboxRpc({
				workspace, home, runtime, launchPath: values.session, ephemeral: values["no-session"], model, wireWrite,
				createSession: (manager, currentModel) => newSession(workspace, initial, manager, currentModel),
			});
		}
		input = createInterface({ input: process.stdin, output: process.stdout, prompt: "codey-sandbox> " });
		const closed = new AbortController();
		input.once("close", () => closed.abort());
		function createSession(cwd, sandbox, current) {
			const manager = SessionManager.inMemory(cwd);
			const sessionManager = current ? SessionManager.inMemory(cwd, undefined, [
				manager.getHeader(), ...structuredClone(current.sessionManager.getBranch()),
			]) : manager;
			return newSession(cwd, sandbox, sessionManager, model, [
				httpsReadTool(terminalApproval(input, cwd, closed.signal), projectDomains(home, cwd).has),
			]);
		}
		const { session } = await createSession(workspace, initial);
		const state = { workspace, sandbox: initial, session };
		initial = undefined;
		// The SDK's Agent can expose a placeholder even when model selection returned nothing.
		await readCommands(state, home, runtime, model, input, createSession);
	} finally {
		finishedStartup();
		input?.close();
		try {
			await runtime?.settleCredentialWrites();
		} finally {
			try { initial?.close(); } finally {
				if (hostDir) rmSync(hostDir, { recursive: true, force: true });
			}
		}
	}
}

async function reviewChanges(sandbox, runtime, model, signal) {
	console.log(styleReviewMarker(">> Code review started: current changes <<"));
	try {
		const { patches } = await sandbox.review(signal);
		if (!patches.length) return console.log("No changes to review.");
		if (!model) throw new Error(noModel);
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
		const response = runtime.stream(model, {
			systemPrompt: reviewSystemPrompt,
			messages: [{ role: "user", content: JSON.stringify(patches), timestamp: Date.now() }],
			tools: [],
		}, { maxTokens: 4096, cacheRetention: "none", signal: deadline });
		let wroteText = false;
		try {
			for await (const event of response) {
				deadline.throwIfAborted();
				if (event.type !== "text_delta") continue;
				const delta = display(event.delta);
				if (!delta) continue;
				process.stdout.write(delta);
				wroteText = true;
			}
		} finally {
			if (wroteText) process.stdout.write("\n");
		}
		deadline.throwIfAborted();
		const result = await response.result();
		if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error("The model request failed.");
		if (!wroteText) console.log("The model returned no review text.");
		if (result.stopReason === "length") console.log("The model reached its output limit.");
	} catch (error) {
		console.log(signal.aborted ? "Code review canceled." : `Review could not finish: ${display(error.message)}`);
	} finally {
		console.log(styleReviewMarker("<< Code review finished >>"));
	}
}

async function readCommands(state, home, runtime, model, input, createSession) {
	const root = state.workspace;
	console.log(`Codey macOS sandbox (workspace-write): ${display(root)}`);
	if (model) console.log(`Model: ${display(model.provider)}/${display(model.id)}`);
	else console.error(noModel);
	console.log("Shell and file tools are offline. HTTPS reads require approval or a project domain grant. Type /help or /quit.");
	let active;
	input.once("close", () => active?.abort());
	input.on("SIGINT", () => {
		if (active) {
			active.abort();
			void state.session.abort();
		} else {
			input.close();
		}
	});
	function onEvent(event) {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(display(event.assistantMessageEvent.delta));
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.errorMessage) console.error(display(event.message.errorMessage));
			process.stdout.write("\n");
		}
	}
	let unsubscribe = state.session.subscribe(onEvent);
	async function switchWorkspace(request, signal) {
		request.verify();
		const sandbox = await openSeatbelt(request.path, home);
		let next;
		try {
			signal.throwIfAborted();
			request.verify();
			next = (await createSession(request.path, sandbox, request.keepHistory ? state.session : undefined)).session;
			signal.throwIfAborted();
		} catch (error) {
			try { next?.dispose(); } finally { sandbox.close(); }
			throw error;
		}
		const old = { ...state };
		unsubscribe();
		state.workspace = request.path;
		state.sandbox = sandbox;
		state.session = next;
		unsubscribe = next.subscribe(onEvent);
		try {
			try { old.session.dispose(); } finally { old.sandbox.close(); }
		} catch {
			console.error("Could not finish cleaning up the previous sandbox.");
		}
		console.log(styleInfo(`• Working directory changed to: ${display(request.path)}`));
	}
	try {
		input.prompt();
		for await (const line of input) {
			const text = line.trim();
			if (text === "/quit") break;
			active = new AbortController();
			try {
				if (text === "/help") console.log(help);
				else if (text === "/review") await reviewChanges(state.sandbox, runtime, model, active.signal);
				else if (/^\/review\s/.test(text)) console.log("Usage: /review (current changes only)");
				else if (text === "/worktree") {
					const request = await worktreeMenu(input, root, home, state.workspace, active.signal);
					if (request) {
						try { await switchWorkspace(request, active.signal); }
						catch (error) { throw new Error(`Could not switch to ${request.path}. ${error.message}`); }
					}
				}
				else if (/^\/worktree\s/.test(text)) console.log("Usage: /worktree");
				else if (text === "/login" || text.startsWith("/login ")) console.log(loginGuidance);
				else if (text.startsWith("/") || text.startsWith("@")) console.log("This command or attachment is unavailable in the macOS sandbox.");
				else if (text.startsWith("!")) {
					const excludeFromContext = text.startsWith("!!");
					const command = text.slice(excludeFromContext ? 2 : 1).trim();
					if (command) {
						const result = await state.sandbox.execute("bash", { command }, active.signal);
						const output = result.content.map((entry) => entry.text).join("\n");
						console.log(display(output));
						state.session.recordBashResult(command, { output, exitCode: result.exitCode ?? 0, cancelled: false, truncated: false }, { excludeFromContext });
					}
				} else if (text) {
					if (model) await state.session.prompt(text, { expandPromptTemplates: false });
					else console.error(noModel);
				}
			} catch (error) {
				if (/^(Authentication failed for |No API key found for )/.test(error.message) && model) {
					console.error(`Authentication is unavailable for "${display(model.provider)}". ${loginGuidance}`);
				} else if (active.signal.aborted && text === "/worktree") console.log("Worktree action canceled.");
				else console.error(display(error.message));
			} finally {
				active = undefined;
			}
			input.prompt();
		}
	} finally {
		unsubscribe();
		input.close();
		try { await state.session.abort(); } finally {
			try { state.session.dispose(); } finally { state.sandbox.close(); }
		}
	}
}

try {
	await launch();
} catch (error) {
	console.error(`Codey macOS sandbox: ${display(error.message)}`);
	process.exitCode = 1;
}
