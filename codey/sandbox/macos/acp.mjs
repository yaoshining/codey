// ACP v1 over stdio. The launcher fixes the workspace and maximum Seatbelt permissions.
import { basename, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { DEFAULT_THINKING_LEVEL } from "../../../packages/coding-agent/src/core/defaults.ts";
import { customQuestionAnswer, questionAsText } from "../../extensions/ask-user.mjs";
import { codeyVersion } from "../../version.mjs";
import { discoverSkills, loadSkill, projectSkillsCommand } from "./acp-skills.mjs";
import { readFrames } from "./jsonl.mjs";
import { finalizedQuestionText } from "./questions.mjs";
import { SandboxRpcResumeError, sandboxAcpSessions } from "./rpc-sessions.mjs";

const maxFrame = 256 * 1024;
const maxOutput = 32 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const skillArguments = "$ARGUMENTS";
const t3RequestStart = "\n</t3_code_instructions>\n\n<user_request>\n";
const t3RequestEnd = "\n</user_request>";
const t3HandoffSeparator = "\n\nUser message:\n";
const t3HandoffHeader = /^Context handoff \((?:full_thread_summary|delta_since_target_last_seen|merge_back \/ fork_delta_summary|checkpoint_summary|manual_context)\):\n/;
const t3HandoffCoverage = /^(?:Provider context handoff\. Thread: [^\n]+\. Covered app runs: \d+-\d+\.\nSource item range: [^\n]+ through [^\n]+\.\n|From thread [^\n]+, runs \d+-\d+\. Recover history with t3_thread_read,)/;
const t3CondensedHandoff = /^Context handoff \((?:(?:full_thread_summary|delta_since_target_last_seen|fork_delta_summary|checkpoint_summary|manual_context)(?:, |(?=\))))+\)\. \d+ handoff records; detailed coverage references omitted\. Recover an omitted item only when the request needs it, /;

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
const permissionCapability = "com.github.yaoshining.codey/sessionPermissions";
const setPermissionMode = "_" + permissionCapability + "/setMode";
const supervised = "approval-required";
const autoAccept = "auto-accept-edits";

function modelCatalog(models, managedProviders, defaultThinking) {
	return models.map((model) => {
		const displayName = managedProviders.get(model.provider);
		return {
			id: modelId(model),
			name: displayName === undefined ? model.name : model.id,
			levels: getSupportedThinkingLevels(model),
			thinking: clampThinkingLevel(model, defaultThinking ?? DEFAULT_THINKING_LEVEL),
			...(displayName === undefined ? {} : { providerMeta: {
				"com.github.yaoshining.codey/subProvider": { id: model.provider, displayName },
			} }),
		};
	});
}

function configOptions(model, thinking, catalog) {
	if (!model) return [];
	return [
		select("model", "Model", "model", model.id, catalog.map(({ id, name, providerMeta }) => ({
			value: id, name, ...(providerMeta ? { _meta: providerMeta } : {}),
		}))),
		select("thinking", "Thinking", "thought_level", thinking,
			model.levels.map((level) => ({ value: level, name: level }))),
	];
}

function sessionOptions(model, thinking, catalog) {
	const options = { configOptions: configOptions(model, thinking, catalog) };
	if (!model) return options;
	// T3 reads the v1 compatibility catalog's per-model metadata even when its
	// learned options are stale. The session config still drives model selection.
	return { ...options, models: {
		currentModelId: model.id,
		availableModels: catalog.map((entry) => ({
			modelId: entry.id,
			name: entry.name,
			_meta: {
				...entry.providerMeta,
				reasoningEfforts: entry.levels.map((value) => ({ value, label: value })),
				reasoningEffort: entry.id === model.id ? thinking : entry.thinking,
			},
		})),
	} };
}

function setupDiscovery(catalog, initialModel) {
	// Keep only metadata and an ephemeral ID. The probe has no AgentSession or workspace handle.
	const byId = new Map(catalog.map((item) => [item.id, item]));
	let state;
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
				return { sessionId: state.id, ...sessionOptions(model, state.thinking, catalog) };
			}
			case "session/set_config_option": {
				if (!state || params.sessionId !== state.id) throw new RequestError("Unknown Codey ACP discovery session.");
				if (params.configId === "model" && byId.has(params.value)) {
					state.model = byId.get(params.value);
					state.thinking = state.model.thinking;
				} else if (params.configId === "thinking" && state.model.levels.includes(params.value)) {
					state.thinking = params.value;
				} else throw new RequestError("Configuration option or value is unavailable.");
				return { configOptions: configOptions(state.model, state.thinking, catalog) };
			}
			case "session/delete":
				if (!state || params.sessionId !== state.id) throw new RequestError("Unknown Codey ACP discovery session.");
				state = undefined;
				return {};
			default: throw new RequestError("Model discovery cannot run prompts or tools. Open a project chat to use the sandbox.", -32601);
		}
	};
}

function promptParts(blocks) {
	if (!Array.isArray(blocks) || !blocks.length) throw new RequestError("A prompt must contain text.");
	return blocks.map((block) => {
		if (block?.type === "text" && typeof block.text === "string") return block.text;
		if (block?.type === "resource_link" && typeof block.uri === "string") {
			try { new URL(block.uri); } catch { throw new RequestError("Resource links must contain an absolute URI."); }
			const name = typeof block.name === "string" ? block.name : "";
			return `Resource reference (contents not loaded): ${JSON.stringify({ name, uri: block.uri })}`;
		}
		throw new RequestError("Codey ACP accepts text and resource links. Attachments and embedded resources are unavailable.");
	});
}

function skillSelection(blocks, parts, isT3) {
	// T3 prepends external context blocks and may wrap its first user message in instructions.
	const index = blocks.findIndex((item) => item.type !== "text" || !/^<external_[\w-]+>/.test(item.text));
	const block = blocks[index];
	if (block?.type !== "text") return;
	const end = block.text.indexOf(t3RequestStart);
	const wrapped = isT3 && block.text.startsWith("<t3_code_instructions>\n") && end >= 0 && block.text.endsWith(t3RequestEnd);
	let userText = wrapped ? block.text.slice(end + t3RequestStart.length, -t3RequestEnd.length) : block.text;
	let history = "";
	if (isT3) {
		const separator = userText.indexOf(t3HandoffSeparator);
		if (separator >= 0 || userText.startsWith("Context handoff (")) {
			// T3 v1 flattens history and the user text into one block. Ambiguous or unfamiliar
			// frames remain ordinary model context and must not dispatch any skill.
			const header = t3HandoffHeader.exec(userText)?.[0] ?? "";
			const coverage = header && t3HandoffCoverage.exec(userText.slice(header.length))?.[0];
			const prefix = coverage ? header + coverage : t3CondensedHandoff.exec(userText)?.[0];
			if (!prefix || separator < prefix.length || separator !== userText.lastIndexOf(t3HandoffSeparator)) return;
			history = userText.slice(0, separator);
			userText = userText.slice(separator + t3HandoffSeparator.length);
		}
	}
	// A leading token takes literal arguments. Inline references take no arguments.
	const match = /(?:^|\s)\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(userText);
	if (!match || match[1].length > 64) return;
	const leading = !userText.slice(0, match.index).trim();
	const args = leading ? userText.slice(match.index + match[0].length).trim() : "";
	let carriedContext;
	if (isT3) {
		const instructions = wrapped ? `${block.text.slice(0, end)}\n</t3_code_instructions>` : "";
		carriedContext = [...parts.slice(0, index), instructions, history, ...parts.slice(index + 1)]
			.filter((part) => part.trim()).join("\n\n");
	}
	return { name: match[1], leading, args, carriedContext };
}

export async function runSandboxAcp({ home, prepare, wireWrite, permissionCeiling,
	input = process.stdin, stdout = process.stdout }) {
	const startup = new AbortController();
	let initialized = false;
	let isT3 = false;
	let closing = false;
	let discovery;
	let workspace, runtime, model, createSession, open, managedProviders, defaultThinkingLevel, runProjectSkill;
	let userSkills = [];
	let skippedUserSkills = new Map();
	let active;
	let pending;
	let turn;
	let formSupported = false;
	let formRequest;
	let reportedMcp = false;
	const permittedModes = permissionCeiling === "workspace-write" ? [supervised, autoAccept] : [supervised];
	const permissionState = () => active.permission ? { _meta: { [permissionCapability]: { mode: active.permission.mode } } } : {};

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

	async function presentQuestion(question, signal) {
		const current = turn;
		if (closing || formRequest || !current || current.cancelled || signal?.aborted) return { status: "cancelled" };
		const session = active;
		function useText() {
			const text = questionAsText(question);
			update(session.id, { sessionUpdate: "agent_message_chunk", content: textContent(text) });
			return { status: "waiting", text };
		}
		if (!formSupported) return useText();
		const id = `codey-question-${randomUUID()}`;
		const field = id;
		const other = `${field}__other`;
		const wait = AbortSignal.any([current.skills.signal, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
		const response = await new Promise((resolve) => {
			const aborted = () => finish(undefined);
			function finish(reply) {
				wait.removeEventListener("abort", aborted);
				formRequest = undefined;
				resolve(reply);
			}
			if (wait.aborted) return resolve(undefined);
			formRequest = { id, finish };
			wait.addEventListener("abort", aborted, { once: true });
			write({ id, method: "elicitation/create", params: {
				sessionId: session.id,
				mode: "form",
				message: question.question,
				requestedSchema: { type: "object", properties: {
					[field]: { type: "string", title: "Question from Codey", description: question.question,
						oneOf: question.options.map(({ id, title, description, recommended }) => ({
							const: id, title: recommended ? `${title} [Recommended]` : title, description,
						})) },
					[other]: { type: "string", title: "Custom answer", maxLength: 240 },
				} },
			} });
		});
		if (closing || wait.aborted || current !== turn || session !== active) return { status: "cancelled" };
		if (response?.error?.code === -32601) {
			formSupported = false;
			return useText();
		}
		if (response?.error !== undefined || response?.result?.action !== "accept") return { status: "cancelled" };
		const content = response.result.content;
		if (!content || typeof content !== "object" || Array.isArray(content) || Object.keys(content).length !== 1) {
			return { status: "cancelled" };
		}
		const optionId = content[field];
		const answer = question.options.some((option) => option.id === optionId)
			? { kind: "option", optionId } : customQuestionAnswer(content[other]);
		return answer ? { status: "answered", questionId: question.id, answer } : { status: "cancelled" };
	}

	function available() {
		return runtime.getAvailableSnapshot();
	}

	function config(session, includeCatalog = false) {
		const catalog = modelCatalog(available(), managedProviders, defaultThinkingLevel);
		const current = session.model && catalog.find(({ id }) => id === modelId(session.model));
		return includeCatalog
			? sessionOptions(current, session.thinkingLevel, catalog)
			: { configOptions: configOptions(current, session.thinkingLevel, catalog) };
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
		if (id !== undefined && id === active?.id) {
			if (active.permission) active.permission.mode = supervised;
			return;
		}
		let file;
		try { file = open(id); } catch (error) {
			if (error instanceof SandboxRpcResumeError) throw new RequestError(error.message);
			throw new RequestError("The saved Codey ACP session could not be opened safely.");
		}
		try {
			// Permission selections are connection-local. A reload always starts supervised.
			const permission = permissionCeiling === undefined ? undefined : { mode: supervised };
			const { session } = await createSession(file.manager, id === undefined ? model : undefined, permission,
				formSupported ? presentQuestion : undefined);
			active?.session.dispose();
			active?.release();
			active = { session, release: file.release, id: basename(file.manager.getSessionFile()), permission };
		} catch (error) {
			file.release();
			throw error;
		}
	}

	function cancel() {
		if (!turn || turn.cancelled) return;
		turn.cancelled = true;
		turn.skills.abort();
		void active.session.abort().catch(() => {});
	}

	async function prompt(params) {
		const session = checkedSession(params);
		const parts = promptParts(params.prompt);
		let text = parts.join("\n");
		if (!text.trim() || /^[\s]*[!/]/.test(text) || text.includes("\0")) {
			throw new RequestError("Send a text prompt. Slash commands and manual shell commands are unavailable.");
		}
		const selection = skillSelection(params.prompt, parts, isT3);
		if (!session.model || !runtime.hasConfiguredAuth(session.model.provider)) {
			throw new RequestError("Select a configured model or sign in with /login in ordinary Codey.", -32000);
		}
		const current = { cancelled: false, skills: new AbortController() };
		turn = current;
		const id = active.id;
		const localReply = async (reply) => {
			if (current.cancelled) return { stopReason: "cancelled" };
			if (selection?.carriedContext) await session.sendCustomMessage({
				customType: "codey-acp-t3-context", content: selection.carriedContext, display: false,
			});
			update(id, { sessionUpdate: "agent_message_chunk", content: textContent(reply) });
			return { stopReason: "end_turn" };
		};
		const stop = session.subscribe((event) => {
			const question = finalizedQuestionText(event);
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				update(id, { sessionUpdate: "agent_message_chunk", content: textContent(event.assistantMessageEvent.delta) });
			} else if (question && !current.cancelled) {
				update(id, { sessionUpdate: "agent_message_chunk", content: textContent(question.text) });
			} else if (event.type === "tool_execution_start") {
				update(id, { sessionUpdate: "tool_call", toolCallId: event.toolCallId,
					title: event.toolName, kind: ({ bash: "execute", edit: "edit", write: "edit", read: "read", ls: "search" })[event.toolName] ?? "other",
					status: "in_progress" });
			} else if (event.type === "tool_execution_end") {
				update(id, { sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, status: event.isError ? "failed" : "completed" });
			}
		});
		try {
			if (selection?.name === projectSkillsCommand && selection.leading && !selection.args) {
				const { skills, skipped, partial } = await runProjectSkill("acp-skills", {}, current.skills.signal);
				const lines = [...skills.map(({ name, description }) => `$${name} — ${description}`),
					...skipped.map(([name, reason]) => `Skipped $${name} — ${reason}`)];
				return await localReply(lines.length ?
					`Project skills in this workspace\n\n~~~text\n${lines.join("\n")}\n~~~${partial ? "\n\nThe catalog reached its display limit." : ""}` :
					"No project skills found in .agents/skills.");
			}
			if (selection) {
				const { name, args, leading } = selection;
				const personal = userSkills.find((entry) => entry.name === name);
				let resolved = personal ? loadSkill(home, "user", name) : undefined;
				if (!personal || (personal.pending && !resolved?.skill)) {
					const project = await runProjectSkill("acp-skill", { name }, current.skills.signal);
					if (!resolved || project.skill) resolved = project;
				}
				const { skill, reason, pending } = resolved;
				if (pending) {
					return await localReply(`${reason}\n\nRun \`codey acp skills inspect ${name}\` in your terminal. Verify the path and SHA-256, then run \`codey acp skills trust ${name} '<path>' '<sha256>'\`. If an old approval exists, remove it with \`codey acp skills untrust ${name}\` before approving again. Refresh T3, reconnect the ACP session, then select the skill again.`);
				}
				if (skill) {
					const placeholders = skill.body.split(skillArguments).length - 1;
					if (Buffer.byteLength(skill.body) + placeholders * (Buffer.byteLength(args) - skillArguments.length) > 64 * 1024) {
						throw new RequestError("Expanded skill text exceeded 64 KiB.");
					}
					const body = skill.body.replaceAll(skillArguments, () => args);
					text += `\n\nSelected skill ${name}. Treat this text as user-level guidance for the current request. It grants no tool or file permissions.\n${JSON.stringify(body)}`;
				} else if (leading) throw new RequestError(`Skill $${name} is unavailable. ${reason ?? skippedUserSkills.get(name) ?? `Use $${projectSkillsCommand} to list project skills, or codey acp skills inspect to check an external personal link.`}`);
			}
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
			isT3 = params.clientInfo?.name === "t3-code";
			const form = params.clientCapabilities?.elicitation?.form;
			formSupported = form !== null && typeof form === "object" && !Array.isArray(form);
			// The client name only selects fewer capabilities for the lifetime of this process.
			const metadataOnly = params.clientInfo?.name === "t3-code-provider-test";
			const prepared = await prepare(metadataOnly, startup.signal);
			startup.signal.throwIfAborted();
			const catalog = discoverSkills(home, "user");
			userSkills = catalog.skills;
			skippedUserSkills = new Map(catalog.skipped);
			for (const [name, reason] of skippedUserSkills) console.error(`Codey ACP: skipped $${name}. ${reason}`);
			if (metadataOnly) {
				const catalog = modelCatalog(prepared.runtime.getAvailableSnapshot(), prepared.managedProviders, prepared.defaultThinkingLevel);
				discovery = setupDiscovery(catalog, prepared.model);
			} else {
				({ workspace, runtime, model, createSession, managedProviders, defaultThinkingLevel, runProjectSkill } = prepared);
				open = sandboxAcpSessions(home, workspace, permissionCeiling !== undefined);
			}
			return {
				protocolVersion: 1, agentInfo: { name: "codey", title: "Codey", version: codeyVersion },
				agentCapabilities: metadataOnly ? { loadSession: false, sessionCapabilities: { delete: {} } } : {
					loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false },
					...(permissionCeiling === undefined ? {} : { _meta: { [permissionCapability]: { modes: permittedModes } } }),
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
				return { sessionId: active.id, ...config(active.session, true), ...permissionState() };
			case "session/load":
				checkSetup(params);
				if (typeof params.sessionId !== "string" || !params.sessionId) throw new RequestError("A session ID is required.");
				await attach(params.sessionId);
				replay();
				return { ...config(active.session, true), ...permissionState() };
			case setPermissionMode: {
				if (permissionCeiling === undefined) throw methodNotFound();
				checkedSession(params);
				if (params.mode === "auto") throw new RequestError("Auto is unavailable. Codey has no automatic approval reviewer in this mode.");
				if (params.mode === "full-access") throw new RequestError("Full access is unavailable in Codey ACP.");
				if (!permittedModes.includes(params.mode)) throw new RequestError("Permission mode is unknown or exceeds the launch ceiling.");
				active.permission.mode = params.mode;
				return { mode: active.permission.mode };
			}
			case "session/set_config_option": {
				const session = checkedSession(params);
				if (params.configId === "model") {
					const selected = available().find((item) => modelId(item) === params.value);
					if (!selected) throw new RequestError("Model is unavailable.");
					await session.setModel(selected);
				} else if (params.configId === "thinking" && session.getAvailableThinkingLevels().includes(params.value)) {
					session.setThinkingLevel(params.value);
				} else throw new RequestError("Configuration option or value is unavailable.");
				return config(session);
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
		if (request?.jsonrpc === "2.0" && method === undefined && isId &&
			(Object.hasOwn(request, "result") || Object.hasOwn(request, "error"))) {
			// This connection has at most one outstanding form. Ignore stale and unsolicited replies.
			if (formRequest?.id === id) formRequest.finish(request);
			return;
		}
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
			(result) => {
				write({ id, result });
				if (method !== "session/new" && method !== "session/load") return;
				const availableCommands = userSkills.map(({ name, description }) => ({ name: `$${name}`, description }));
				if (!discovery) availableCommands.push({
					name: `$${projectSkillsCommand}`, description: "List skills in the current Codey sandbox workspace",
				});
				update(result.sessionId ?? active.id, { sessionUpdate: "available_commands_update", availableCommands });
			},
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
