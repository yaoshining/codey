// Shared question schema and terminal presenter. An answer never grants tool permissions.
import { Text } from "@earendil-works/pi-tui";

const idPattern = "^[a-z][a-z0-9_-]{0,23}$";
const identifier = new RegExp(idPattern);
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const plain = (value, max) => typeof value === "string" && value.length <= max && !controls.test(value) && value.trim().length > 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const askUserTool = {
	name: "ask_user",
	description: "Ask one short question about requirements or preferences. Send this call alone. Wait for a confirmed answer. Never use it to request permission, credentials, or a change of mode.",
	parameters: {
		type: "object", additionalProperties: false, required: ["id", "question", "options"],
		properties: {
			id: { type: "string", pattern: idPattern },
			question: { type: "string", minLength: 1, maxLength: 160 },
			options: { type: "array", minItems: 2, maxItems: 4, items: {
				type: "object", additionalProperties: false, required: ["id", "title", "description"],
				properties: {
					id: { type: "string", pattern: idPattern },
					title: { type: "string", minLength: 1, maxLength: 40 },
					description: { type: "string", minLength: 1, maxLength: 100 },
					recommended: { type: "boolean" },
				},
			} },
		},
	},
};

export const isQuestionCall = (call) => call.type === "toolCall" && call.name === askUserTool.name && !call.namespace;
export const questionBatchMessage = "The model attempted to ask a question alongside other tool calls. No action was taken.";
export const invalidQuestionMessage = "The model returned an invalid question. No answer was submitted.";
export const cancelledQuestionMessage = "Question canceled. No answer was submitted.";

export function parseQuestion(input) {
	if (!object(input) || Object.keys(input).some((key) => !["id", "question", "options"].includes(key)) ||
		typeof input.id !== "string" || !identifier.test(input.id) || !plain(input.question, 160) ||
		!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 4) return;
	const ids = new Set();
	const titles = new Set();
	const options = [];
	let recommended = false;
	for (const option of input.options) {
		if (!object(option) || Object.keys(option).some((key) => !["id", "title", "description", "recommended"].includes(key)) ||
			typeof option.id !== "string" || !identifier.test(option.id) || ids.has(option.id) ||
			!plain(option.title, 40) || !plain(option.description, 100) ||
			(option.recommended !== undefined && typeof option.recommended !== "boolean")) return;
		const title = option.title.trim();
		const key = title.normalize("NFKC").toLowerCase();
		if (titles.has(key) || (recommended && option.recommended)) return;
		titles.add(key);
		ids.add(option.id);
		recommended ||= option.recommended === true;
		options.push({ id: option.id, title, description: option.description.trim(), recommended: option.recommended === true });
	}
	return { id: input.id, question: input.question.trim(), options };
}

const labels = (question) => question.options.map(({ title, description, recommended }, index) =>
	`${index + 1}. ${title}${recommended ? " [Recommended]" : ""} — ${description}`);

export function questionAsText(question) {
	return [question.question, ...labels(question), "Reply with a choice or your own answer in a new message."].join("\n");
}

let active = false;

export async function presentQuestion(question, ctx, signal) {
	if (signal?.aborted) return { status: "cancelled" };
	if (ctx.mode !== "tui" || !ctx.hasUI) return { status: "waiting", text: questionAsText(question) };
	if (active) return { status: "busy" };
	active = true;
	const deadline = AbortSignal.timeout(120_000);
	const options = { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, blockedKind: "question" };
	try {
		const choices = labels(question);
		const custom = "Write a custom answer";
		const selected = await ctx.ui.select(`Question from the model\n${question.question}`, ["Cancel question", ...choices, custom], options);
		if (options.signal.aborted) return { status: "cancelled" };
		const index = choices.indexOf(selected);
		let answer, preview;
		if (selected === custom) {
			const text = await ctx.ui.input("Your answer", undefined, options);
			if (!plain(text, 240)) return { status: "cancelled" };
			preview = text.trim();
			answer = { kind: "custom", text: preview };
		} else if (index !== -1) {
			const option = question.options[index];
			preview = option.title;
			answer = { kind: "option", optionId: option.id };
		} else return { status: "cancelled" };

		const confirmed = await ctx.ui.select(`Confirm answer\n${preview}`, ["Cancel answer", "Send answer"], options);
		if (confirmed !== "Send answer" || options.signal.aborted) return { status: "cancelled" };
		return { status: "answered", questionId: question.id, answer };
	} catch {
		return { status: "cancelled" };
	} finally {
		active = false;
	}
}

export default function askUser(pi) {
	pi.on("message_end", ({ message }, ctx) => {
		if (message.role !== "assistant") return;
		const calls = message.content.filter((part) => part.type === "toolCall");
		const call = calls.find((part) => part.name === askUserTool.name);
		if (!call) return;
		const question = isQuestionCall(call) && parseQuestion(call.arguments);
		let text;
		if (calls.length !== 1) text = questionBatchMessage;
		else if (!question || message.stopReason === "length") text = invalidQuestionMessage;
		else if (ctx.mode !== "tui" || !ctx.hasUI) text = questionAsText(question);
		else return;
		// Pi inspects the finalized assistant message before dispatching the batch.
		// A text-only replacement stops the turn and preserves a normal transcript.
		if (ctx.mode === "tui" && ctx.hasUI) {
			try { ctx.ui.notify(text, "warning"); } catch { /* The TUI may already be closing. */ }
		}
		return { message: { ...message, content: [{ type: "text", text }], stopReason: "stop" } };
	});
	pi.registerTool({
		...askUserTool, label: "Ask user", exposure: "model-only", executionMode: "sequential",
		renderCall: () => new Text("Ask user", 0, 0),
		async execute(_id, params, signal, _update, ctx) {
			const question = parseQuestion(params);
			const result = question ? await presentQuestion(question, ctx, signal) : { status: "invalid" };
			const answered = result.status === "answered";
			const text = answered ? JSON.stringify(result) : result.text ?? (result.status === "invalid" ? invalidQuestionMessage : cancelledQuestionMessage);
			return { content: [{ type: "text", text }], details: result, terminate: !answered };
		},
	});
}
