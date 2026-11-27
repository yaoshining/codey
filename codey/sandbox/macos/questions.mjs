// Host-only presentation. Question responses never reach the Seatbelt tool worker.
import { randomBytes } from "node:crypto";
import { createEventBus } from "../../../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../packages/coding-agent/src/core/extensions/loader.ts";
import { cancelledQuestionMessage, customQuestionAnswer, questionLines, registerAskUser } from "../../extensions/ask-user.mjs";

const finalizedText = new WeakMap();

export async function sandboxQuestionExtensions(cwd, enabled, present, canPresent) {
	const runtime = createExtensionRuntime();
	const extensions = enabled ? [await loadExtensionFromFactory((pi) => registerAskUser(pi, {
		present,
		canPresent,
		onText: (message, text) => finalizedText.set(message, { text, index: message.content.length }),
	}), cwd, createEventBus(), runtime, "<codey:sandbox-questions>")] : [];
	return { extensions, errors: [], runtime };
}

export function finalizedQuestionText(event) {
	return event.type === "message_end" ? finalizedText.get(event.message) : undefined;
}

export async function terminalQuestion(input, closed, question, signal) {
	const wait = AbortSignal.any([closed, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
	try {
		wait.throwIfAborted();
		console.log(`\nQuestion from the model\n${question.question}\n${questionLines(question).join("\n")}\n${question.options.length + 1}. Write a custom answer`);
		const choose = await input.question("Choose a number, or press Enter to cancel: ", { signal: wait });
		wait.throwIfAborted();
		const index = ["1", "2", "3", "4", "5"].indexOf(choose.trim());
		const option = question.options[index];
		const answer = option ? { kind: "option", optionId: option.id } :
			index === question.options.length ? customQuestionAnswer(await input.question("Your answer: ", { signal: wait })) : undefined;
		if (answer) {
			wait.throwIfAborted();
			const confirm = `send ${randomBytes(4).toString("hex")}`;
			console.log(`Confirm answer: ${option?.title ?? answer.text}`);
			const reply = await input.question(`Type ${confirm} to send, or press Enter to cancel: `, { signal: wait });
			if (!wait.aborted && reply === confirm) return { status: "answered", questionId: question.id, answer };
		}
	} catch (error) {
		if (!wait.aborted) throw error;
	}
	if (!closed.aborted) console.log(cancelledQuestionMessage);
	return { status: "cancelled" };
}
