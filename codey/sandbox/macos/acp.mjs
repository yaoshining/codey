// ACP v1 over stdio. Protocol input never grants workspace, network, or tool permissions.
import { basename, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { DEFAULT_THINKING_LEVEL } from "../../../packages/coding-agent/src/core/defaults.ts";
import { codeyVersion } from "../../version.mjs";
import { readFrames } from "./jsonl.mjs";
import { SandboxRpcResumeError, sandboxAcpSessions } from "./rpc-sessions.mjs";

const maxFrame = 256 * 1024;
const maxOutput = 32 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

class RequestError extends Error {
	constructor(message, code = -32602) {
		super(message);
		this.code = code;
	}
}

const methodNotFound = () => new RequestError("Method is unavailable in Codey ACP.", -32601);
const select = (id, name, category, currentValue, options) => ({ id, name, category, type: "select", currentValue, options });
const modelId = (model) => `${model.provider}/${model.id}`;
const textContent = (text) => ({ type: "text", text });

function configOptions(model, thinking, models) {
	if (!model) return [];
	return [
		select("model", "Model", "model", modelId(model), models.map((item) => ({ value: modelId(item), name: item.name }))),
		select("thinking", "Thinking", "thought_level", thinking,
			getSupportedThinkingLevels(model).map((level) => ({ value: level, name: level }))),
	];
}

function setupDiscovery(models, initialModel, defaultThinking) {
	// Keep only metadata and an ephemeral ID. The probe has no AgentSession or workspace handle.
	const catalog = models.map((model) => ({
		id: modelId(model),
		levels: getSupportedThinkingLevels(model),
		thinking: clampThinkingLevel(model, defaultThinking ?? DEFAULT_THINKING_LEVEL),
		name: model.name,
	}));
	const byId = new Map(catalog.map((item) => [item.id, item]));
	let state;
	const options = () => ({ configOptions: [
		select("model", "Model", "model", state.model.id, catalog.map(({ id, name }) => ({ value: id, name }))),
		select("thinking", "Thinking", "thought_level", state.thinking,
			state.model.levels.map((level) => ({ value: level, name: level }))),
	] });
	return (method, params) => {
		switch (method) {
			case "session/new": {
				if (typeof params.cwd !== "string" || !isAbsolute(params.cwd) ||
					!Array.isArray(params.mcpServers) || params.mcpServers.length ||
					(params.additionalDirectories !== undefined &&
						(!Array.isArray(params.additionalDirectories) || params.additionalDirectories.length))) {
					throw new RequestError("Model discovery cannot use MCP servers or additional workspace directories.");
				}
				const model = (initialModel && byId.get(modelId(initialModel))) ?? catalog[0];
				if (!model) throw new RequestError("No model available. Sign in with /login in ordinary Codey and refresh this provider.", -32000);
				state = { id: randomUUID(), model, thinking: model.thinking };
				return { sessionId: state.id, ...options() };
			}
			case "session/set_config_option": {
				if (!state || params.sessionId !== state.id) throw new RequestError("Unknown Codey ACP discovery session.");
				if (params.configId === "model" && byId.has(params.value)) {
					state.model = byId.get(params.value);
					state.thinking = state.model.thinking;
				} else if (params.configId === "thinking" && state.model.levels.includes(params.value)) {
					state.thinking = params.value;
				} else throw new RequestError("Configuration option or value is unavailable.");
				return options();
			}
			case "session/delete":
				if (!state || params.sessionId !== state.id) throw new RequestError("Unknown Codey ACP discovery session.");
				state = undefined;
				return {};
			default: throw new RequestError("Model discovery cannot run prompts or tools. Open a project chat to use the sandbox.", -32601);
		}
	};
}

function promptText(blocks) {
	if (!Array.isArray(blocks) || !blocks.length) throw new RequestError("A prompt must contain text.");
	const text = blocks.map((block) => {
		if (block?.type === "text" && typeof block.text === "string") return block.text;
		if (block?.type === "resource_link" && typeof block.uri === "string") {
			try { new URL(block.uri); } catch { throw new RequestError("Resource links must contain an absolute URI."); }
			const name = typeof block.name === "string" ? block.name : "";
			return `Resource reference (contents not loaded): ${JSON.stringify({ name, uri: block.uri })}`;
		}
		throw new RequestError("Codey ACP accepts text and resource links. Attachments and embedded resources are unavailable.");
	}).join("\n");
	if (!text.trim() || /^[\s]*[!/]/.test(text) || text.includes("\0")) {
		throw new RequestError("Send a text prompt. Slash commands and manual shell commands are unavailable.");
	}
	return text;
}

export async function runSandboxAcp({ home, prepare, wireWrite,
	input = process.stdin, stdout = process.stdout }) {
	const startup = new AbortController();
	let initialized = false;
	let closing = false;
	let discovery;
	let workspace, runtime, model, createSession, open;
	let active;
	let pending;
	let turn;
	let reportedMcp = false;

	function disconnect() {
		if (closing) return;
		closing = true;
		startup.abort();
		input.destroy();
		cancel();
	}

	function write(value) {
		if (closing) return;
		const line = JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n";
		if (stdout.writableLength + Buffer.byteLength(line) > maxOutput) {
			console.error("Codey ACP: output exceeded the client buffer limit.");
			disconnect();
			return;
		}
		wireWrite(line);
	}

	function update(id, item) {
		write({ method: "session/update", params: { sessionId: id, update: item } });
	}

	function available() {
		return runtime.getAvailableSnapshot();
	}

	function config(session) {
		return configOptions(session.model, session.thinkingLevel, available());
	}

	function checkedSession(params) {
		if (!active || params.sessionId !== active.id) throw new RequestError("Unknown Codey ACP session.");
		return active.session;
	}

	function checkSetup(params) {
		if (typeof params.cwd !== "string" || !isAbsolute(params.cwd) || params.cwd !== workspace) {
			throw new RequestError("The session cwd must match the sandbox workspace selected at launch.");
		}
		if (!Array.isArray(params.mcpServers)) throw new RequestError("mcpServers must be an array.");
		if (params.mcpServers.length && !reportedMcp) {
			// T3 v1 fallback may attach its own stdio bridge even without MCP capabilities.
			reportedMcp = true;
			console.error("Codey ACP: client-provided MCP servers are disabled by the sandbox.");
		}
		if (params.additionalDirectories !== undefined &&
			(!Array.isArray(params.additionalDirectories) || params.additionalDirectories.length)) {
			throw new RequestError("Additional workspace directories are unavailable in Codey ACP.");
		}
		if (!available().length && !(model && runtime.hasConfiguredAuth(model.provider))) {
			throw new RequestError("No model available. Sign in with /login in ordinary Codey and reopen this ACP connection.", -32000);
		}
	}

	function replay() {
		for (const message of active.session.messages) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const chunks = typeof message.content === "string" ? [textContent(message.content)] : message.content;
			for (const content of chunks) {
				if (content.type === "text") update(active.id, {
					sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
					content: textContent(content.text),
				});
			}
		}
	}

	async function attach(id) {
		if (id !== undefined && id === active?.id) return;
		let file;
		try { file = open(id); } catch (error) {
			if (error instanceof SandboxRpcResumeError) throw new RequestError(error.message);
			throw new RequestError("The saved Codey ACP session could not be opened safely.");
		}
		try {
			const { session } = await createSession(file.manager, id === undefined ? model : undefined);
			active?.session.dispose();
			active?.release();
			active = { session, release: file.release, id: basename(file.manager.getSessionFile()) };
		} catch (error) {
			file.release();
			throw error;
		}
	}

	function cancel() {
		if (!turn || turn.cancelled) return;
		turn.cancelled = true;
		void active.session.abort().catch(() => {});
	}

	async function prompt(params) {
		const session = checkedSession(params);
		const text = promptText(params.prompt);
		if (!session.model || !runtime.hasConfiguredAuth(session.model.provider)) {
			throw new RequestError("Select a configured model or sign in with /login in ordinary Codey.", -32000);
		}
		const current = { cancelled: false };
		turn = current;
		const id = active.id;
		const stop = session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				update(id, { sessionUpdate: "agent_message_chunk", content: textContent(event.assistantMessageEvent.delta) });
			} else if (event.type === "tool_execution_start") {
				update(id, { sessionUpdate: "tool_call", toolCallId: event.toolCallId,
					title: event.toolName, kind: ({ bash: "execute", edit: "edit", write: "edit", read: "read", ls: "search" })[event.toolName] ?? "other",
					status: "in_progress" });
			} else if (event.type === "tool_execution_end") {
				update(id, { sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, status: event.isError ? "failed" : "completed" });
			}
		});
		try {
			await session.prompt(text, {
				expandPromptTemplates: false,
				preflightResult() {
					if (current.cancelled) void session.abort().catch(() => {});
				},
			});
			const last = session.messages.findLast((message) => message.role === "assistant");
			if (current.cancelled || last?.stopReason === "aborted") return { stopReason: "cancelled" };
			if (last?.stopReason === "error") throw new RequestError("The model request failed.", -32603);
			return { stopReason: last?.stopReason === "length" ? "max_tokens" : "end_turn" };
		} catch (error) {
			if (current.cancelled) return { stopReason: "cancelled" };
			throw error;
		} finally {
			stop();
			turn = undefined;
		}
	}

	async function dispatch(method, params) {
		if (method === "initialize") {
			if (initialized || !Number.isInteger(params.protocolVersion) || params.protocolVersion < 1) {
				throw new RequestError("Codey supports ACP protocol version 1.");
			}
			initialized = true;
			// The client name only selects fewer capabilities for the lifetime of this process.
			const metadataOnly = params.clientInfo?.name === "t3-code-provider-test";
			const prepared = await prepare(metadataOnly, startup.signal);
			startup.signal.throwIfAborted();
			if (metadataOnly) {
				discovery = setupDiscovery(prepared.runtime.getAvailableSnapshot(), prepared.model, prepared.defaultThinkingLevel);
			} else {
				({ workspace, runtime, model, createSession } = prepared);
				open = sandboxAcpSessions(home, workspace);
			}
			return {
				protocolVersion: 1, agentInfo: { name: "codey", title: "Codey", version: codeyVersion },
				agentCapabilities: metadataOnly ? { loadSession: false, sessionCapabilities: { delete: {} } } : {
					loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false },
				},
				authMethods: [],
			};
		}
		if (!initialized) throw new RequestError("Initialize the ACP connection first.");
		if (discovery) return discovery(method, params);
		if (!open) throw new RequestError("Codey could not start Seatbelt for this workspace.", -32603);
		switch (method) {
			case "session/new":
				checkSetup(params);
				await attach();
				return { sessionId: active.id, configOptions: config(active.session) };
			case "session/load":
				checkSetup(params);
				if (typeof params.sessionId !== "string" || !params.sessionId) throw new RequestError("A session ID is required.");
				await attach(params.sessionId);
				replay();
				return { configOptions: config(active.session) };
			case "session/set_config_option": {
				const session = checkedSession(params);
				if (params.configId === "model") {
					const selected = available().find((item) => modelId(item) === params.value);
					if (!selected) throw new RequestError("Model is unavailable.");
					await session.setModel(selected);
				} else if (params.configId === "thinking" && session.getAvailableThinkingLevels().includes(params.value)) {
					session.setThinkingLevel(params.value);
				} else throw new RequestError("Configuration option or value is unavailable.");
				return { configOptions: config(session) };
			}
			case "session/prompt": return prompt(params);
			default: throw methodNotFound();
		}
	}

	function failure(id, code, message) {
		write({ id, error: { code, message } });
	}

	function onFrame(frame) {
		let request;
		try { request = JSON.parse(decoder.decode(frame)); } catch {
			failure(null, -32700, "Invalid ACP JSON.");
			return;
		}
		const { id, method, params = {} } = request ?? {};
		const isId = id === null || typeof id === "string" || Number.isSafeInteger(id);
		if (request?.jsonrpc !== "2.0" || typeof method !== "string" || (id !== undefined && !isId)) {
			failure(isId ? id : null, -32600, "Invalid ACP request.");
			return;
		}
		if (id === undefined) {
			if (method === "session/cancel" && params?.sessionId === active?.id) cancel();
			return;
		}
		if (pending) {
			failure(id, -32600, "Wait for the active request or send session/cancel.");
			return;
		}
		if (!params || typeof params !== "object" || Array.isArray(params)) {
			failure(id, -32602, "Invalid ACP request parameters.");
			return;
		}
		pending = dispatch(method, params).then(
			(result) => write({ id, result }),
			(error) => error instanceof RequestError ? failure(id, error.code, error.message) :
				failure(id, -32603, "The Codey ACP operation failed."),
		).finally(() => { pending = undefined; });
	}

	const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
	stdout.on("error", disconnect);
	for (const signal of signals) process.on(signal, disconnect);
	try {
		await readFrames(input, maxFrame, onFrame, () => failure(null, -32600, "ACP frame exceeded 256 KiB."));
	} catch (error) {
		if (!closing) throw error;
	} finally {
		disconnect();
		await pending;
		try { active?.session.dispose(); } finally { active?.release(); }
		stdout.off("error", disconnect);
		for (const signal of signals) process.off(signal, disconnect);
	}
}
