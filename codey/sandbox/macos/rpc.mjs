// Serve an explicit subset of Pi JSONL on the isolated SDK session.
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { THINKING_LEVEL_OPTIONS } from "../../../packages/coding-agent/src/core/defaults.ts";
import { toJsonEvent } from "../../../packages/coding-agent/src/modes/json-event.ts";
import { serializeJsonLine } from "../../../packages/coding-agent/src/modes/rpc/jsonl.ts";
import { SandboxRpcResumeError, sandboxRpcSessions } from "./rpc-sessions.mjs";

const maxRequest = 256 * 1024;
const maxOutput = 16 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const extraFields = new Map([
	["prompt", ["message", "streamingBehavior"]], ["set_model", ["provider", "modelId"]],
	["set_thinking_level", ["level"]], ["set_session_name", ["name"]],
	["switch_session", ["sessionPath"]], ["get_entries", ["since"]],
]);
const commands = new Set([
	...extraFields.keys(), "get_state", "get_commands", "get_available_models", "get_available_thinking_levels",
	"abort", "clear_queue", "new_session", "get_messages", "get_last_assistant_text", "get_session_stats",
]);

export async function runSandboxRpc({ workspace, home, runtime, launchPath, ephemeral, model, createSession, wireWrite }) {
	const open = sandboxRpcSessions(home, workspace, ephemeral);
	let session, unsubscribe, release, turn, mutation, closing = false;

	async function replace(path, selected) {
		if (session?.sessionFile && session.sessionFile === path) return;
		const file = open(path);
		let next;
		try {
			next = (await createSession(file.manager, selected)).session;
		} catch (error) {
			file.release();
			throw error;
		}
		unsubscribe?.();
		session?.dispose();
		release?.();
		session = next;
		release = file.release;
		unsubscribe = session.subscribe((event) => {
			try { output(toJsonEvent(event)); } catch { disconnect(); }
		});
	}
	function stopTurn() {
		if (turn) turn.cancelled = true;
		return session?.abort();
	}
	function disconnect() {
		if (closing) return;
		closing = true;
		process.stdin.destroy();
		void stopTurn()?.catch(() => {});
	}
	function output(value) {
		if (closing) return;
		const line = serializeJsonLine(value);
		if (process.stdout.writableLength + Buffer.byteLength(line) > maxOutput) {
			console.error("Codey macOS sandbox: RPC output exceeded the client buffer limit.");
			disconnect();
			process.stdout.destroy();
			return;
		}
		wireWrite(line);
	}
	function respond(id, command, data) {
		output({ id, type: "response", command, success: true, data });
	}
	function fail(id, command, error) {
		output({ id, type: "response", command, success: false, error });
	}

	function selectedModel() {
		const current = session.model;
		return current && runtime.hasConfiguredAuth(current.provider) ? current : undefined;
	}

	function dispatch(request) {
		const { type, id } = request;
		if (!commands.has(type)) throw new Error("Command is unavailable in the macOS sandbox RPC mode.");
		const fields = extraFields.get(type) ?? [];
		if (Object.keys(request).some((key) => key !== "id" && key !== "type" && !fields.includes(key))) {
			throw new Error("Unsupported RPC fields for this command.");
		}
		switch (type) {
			case "get_state":
				return {
					model: wireModel(selectedModel()), sessionId: session.sessionId, sessionFile: session.sessionFile,
					sessionName: session.sessionName, thinkingLevel: session.thinkingLevel,
					isStreaming: Boolean(turn) || session.isStreaming, isCompacting: false, autoCompactionEnabled: false,
					steeringMode: session.steeringMode, followUpMode: session.followUpMode,
					messageCount: session.messages.length, pendingMessageCount: 0,
				};
			case "get_commands": return { commands: [] };
			case "get_available_models": return { models: runtime.getAvailableSnapshot().map(wireModel) };
			case "get_available_thinking_levels": return { levels: session.getAvailableThinkingLevels() };
			case "get_messages": return { messages: session.messages };
			case "get_last_assistant_text": return { text: session.getLastAssistantText() };
			case "get_session_stats": return session.getSessionStats();
			case "get_entries": {
				const manager = session.sessionManager;
				let entries = manager.getEntries();
				if (request.since !== undefined) {
					stringField(request.since, "entry ID");
					const index = entries.findIndex((entry) => entry.id === request.since);
					if (index === -1) throw new Error("Session entry not found.");
					entries = entries.slice(index + 1);
				}
				return { entries, leafId: manager.getLeafId() };
			}
			case "clear_queue": return { steering: [], followUp: [] };
			case "abort": return stopTurn();
		}
		if (turn || mutation || !session.isIdle) throw new Error("Wait for the active operation or send abort.");
		switch (type) {
			case "prompt": {
				const message = stringField(request.message, "message", maxRequest);
				if (/^\s*[/!@]/.test(message)) throw new Error("Slash commands, manual shell commands and attachments are unavailable in sandbox RPC.");
				if (request.streamingBehavior !== undefined && !["steer", "followUp"].includes(request.streamingBehavior)) {
					throw new Error("Invalid streaming behavior.");
				}
				if (!selectedModel()) throw new Error("No model available. Configure login in ordinary Codey and restart the sandbox.");
				const active = { cancelled: false };
				turn = active;
				let acknowledged = false;
				active.done = session.prompt(message, {
					source: "rpc", expandPromptTemplates: false,
					preflightResult(disposition) {
						acknowledged = true;
						if (active.cancelled || closing) void stopTurn()?.catch(() => {});
						respond(id, type, { disposition });
					},
				}).catch(() => {
					if (!acknowledged) fail(id, type, "The sandbox model could not start this prompt.");
				}).finally(() => { turn = undefined; });
				return;
			}
			case "set_model": {
				const provider = stringField(request.provider, "provider");
				const modelId = stringField(request.modelId, "model ID");
				const selected = runtime.getAvailableSnapshot().find((item) => item.provider === provider && item.id === modelId);
				if (!selected) throw new Error("Model is not in the sandbox catalog.");
				return mutate(async () => { await session.setModel(selected); return wireModel(selected); });
			}
			case "set_thinking_level":
				if (!THINKING_LEVEL_OPTIONS.includes(request.level)) throw new Error("Invalid thinking level.");
				if (!session.getAvailableThinkingLevels().includes(request.level)) throw new Error("Thinking level unavailable for the selected model.");
				session.setThinkingLevel(request.level);
				return;
			case "set_session_name":
				session.setSessionName(stringField(request.name, "name"));
				return;
			case "new_session":
			case "switch_session": {
				const path = type === "switch_session" ? stringField(request.sessionPath, "session path", 4096) : undefined;
				return mutate(async () => {
					await replace(path, path === undefined ? selectedModel() : undefined);
					return { cancelled: false };
				});
			}
		}
	}

	function mutate(fn) {
		const work = fn().finally(() => { mutation = undefined; });
		mutation = work;
		return work;
	}

	function onFrame(frame) {
		if (closing) return;
		let request;
		try {
			request = JSON.parse(utf8.decode(frame));
			if (!request || Array.isArray(request) || typeof request !== "object" ||
				typeof request.type !== "string" || !/^[a-z_]{1,64}$/.test(request.type) ||
				(request.id !== undefined && (typeof request.id !== "string" || request.id.length > 256))) throw new Error();
		} catch {
			fail(undefined, "parse", "Invalid RPC JSONL request.");
			return;
		}
		const { id, type } = request;
		try {
			const result = dispatch(request);
			if (type === "prompt") return;
			if (result instanceof Promise) void result.then((data) => respond(id, type, data), (error) => {
				const message = error instanceof SandboxRpcResumeError ? error.message : "The sandbox RPC operation failed.";
				fail(id, type, message);
			});
			else respond(id, type, result);
		} catch (error) {
			fail(id, type, error.message);
		}
	}

	process.stdout.on("error", disconnect);
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, disconnect);
	try {
		await replace(launchPath, model);
		try {
			await readFrames(process.stdin, onFrame, () => fail(undefined, "parse", "RPC frame exceeded 256 KiB."));
		} catch (error) {
			if (!closing) throw error;
		}
	} finally {
		disconnect();
		await mutation?.catch(() => {});
		await turn?.done;
		try { await stopTurn(); } finally {
			unsubscribe?.();
			try { session?.dispose(); } finally { release?.(); }
		}
		for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.off(signal, disconnect);
	}
}

function wireModel(model) {
	if (!model) return undefined;
	// Configured model headers and endpoint URLs can include host credentials.
	const { id, provider, name, api, input, reasoning, contextWindow, maxTokens, cost } = model;
	const supported = reasoning && getSupportedThinkingLevels(model);
	const thinkingLevelMap = supported && Object.fromEntries(
		THINKING_LEVEL_OPTIONS.map((level) => [level, supported.includes(level) ? level : null]),
	);
	return { id, provider, name, api, input, reasoning, contextWindow, maxTokens, cost, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) };
}

function stringField(value, field, limit = 512) {
	if (typeof value !== "string" || value.length > limit || !value.trim() || value.includes("\0")) {
		throw new Error(`Invalid RPC ${field}.`);
	}
	return value;
}

async function readFrames(input, onFrame, tooLarge) {
	let parts = [], size = 0;
	for await (const chunk of input) {
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			const end = newline < 0 ? chunk.length : newline;
			if (size <= maxRequest) {
				size += end - offset;
				if (size > maxRequest) {
					parts = [];
					tooLarge();
				} else if (end !== offset) parts.push(chunk.subarray(offset, end));
			}
			if (newline < 0) break;
			if (size && size <= maxRequest) onFrame(Buffer.concat(parts, size));
			parts = [];
			size = 0;
			offset = newline + 1;
		}
	}
}
