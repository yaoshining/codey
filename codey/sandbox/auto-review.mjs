// Advisory reviews of already-eligible actions. This module has no execution or approval hook.
import { randomUUID } from "node:crypto";
import { raceWithAbortSignal } from "../../packages/coding-agent/src/utils/abort.ts";

const prompt = [
	"You are an independent reviewer for a sandboxed workspace edit.",
	"The input contains only trusted, redacted action metadata. If that is insufficient, choose deny.",
	'Use this exact JSON shape and key order: {"reviewId":"<input reviewId>","recommendation":"allow"}. Use "deny" to reject.',
].join(" ");
const maxActions = 256;
const maxEditBytes = 64 * 1024;
const reply = /^[ \t\r\n]*\{[ \t\r\n]*"reviewId"[ \t\r\n]*:[ \t\r\n]*"([a-f0-9-]{36})"[ \t\r\n]*,[ \t\r\n]*"recommendation"[ \t\r\n]*:[ \t\r\n]*"(allow|deny)"[ \t\r\n]*\}[ \t\r\n]*$/;

export function createAutoReviewer({ enabled = false, provider, modelId, runtime, timeoutMs = 10_000 } = {}) {
	const configured = typeof provider === "string" && provider.length > 0 &&
		typeof modelId === "string" && modelId.length > 0 &&
		Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000;
	const seen = new Set();
	const deny = (reason) => ({ recommendation: "deny", reason });
	return async (action, signal) => {
		if (enabled !== true) return deny("disabled");
		// The caller must be the policy enforcement layer. It issues each ID and
		// fingerprints the full staged action, including its workspace and payload.
		const { id, fingerprint, kind, boundary, byteCount } = action ?? {};
		if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) return deny("boundary");
		if (seen.has(id) || seen.size >= maxActions) return deny("duplicate-or-limit");
		seen.add(id);
		if (kind !== "workspace-edit" || boundary !== "eligible" ||
			typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint) ||
			!Number.isSafeInteger(byteCount) || byteCount < 1 || byteCount > maxEditBytes) return deny("boundary");
		if (signal?.aborted) return deny("cancelled");
		if (!configured) return deny("unavailable");

		const deadline = AbortSignal.timeout(timeoutMs);
		const reviewSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
		try {
			const model = runtime?.getModel(provider, modelId);
			if (model?.provider !== provider || model?.id !== modelId) return deny("unavailable");
			const reviewId = randomUUID();
			reviewSignal.throwIfAborted();
			const result = await raceWithAbortSignal(runtime.complete(model, {
				systemPrompt: prompt,
				messages: [{ role: "user", content: JSON.stringify({ reviewId, kind, byteCount }), timestamp: Date.now() }],
				tools: [],
			}, { signal: reviewSignal, maxTokens: 128, cacheRetention: "none" }), reviewSignal);
			reviewSignal.throwIfAborted();
			const text = result?.content?.[0];
			if (result?.stopReason !== "stop" || result.content?.length !== 1 || text?.type !== "text" ||
				typeof text.text !== "string" || text.text.length > 512) return deny("invalid-output");
			const decision = reply.exec(text.text);
			if (decision?.[1] !== reviewId) return deny("invalid-output");
			if (decision[2] === "deny") return deny("reviewer-denied");
			return Object.freeze({ recommendation: "would-allow", actionId: id, fingerprint });
		} catch {
			return deny(signal?.aborted ? "cancelled" : deadline.aborted ? "timeout" : "unavailable");
		}
	};
}
