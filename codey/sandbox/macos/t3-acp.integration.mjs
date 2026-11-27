// Run from packages/provider-acp-registry in the pinned T3 source checkout.
import assert from "node:assert/strict";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { handoffCoverage } from "@t3tools/provider-core/server/handoffBudget";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as Registry from "./src/server/AcpRegistrySupport.ts";
import { AcpRegistryRuntimeCoordinator } from "./src/server/AcpRegistryRuntimeCoordinator.ts";
import { AcpRegistrySettings } from "./src/settings.ts";
import { makeAcpRegistryAdapterV2 } from "./src/server/adapter.ts";
import { AcpRegistryDriver } from "./src/server/driver.ts";
import { makeAcpRegistryLearnedModelOptionsStore } from "./src/server/learnedModelOptions.ts";
import { probeAcpRegistryConfiguration } from "./src/server/probe.ts";
import { deliverContextHandoffs, withInlineContext } from "./codey-context-handoff-fixture.ts";

const [binary, cwd, mode, version] = process.argv.slice(2);
const threadId = "thread:codey-acp-fixture";
const selection = { instanceId: "acpRegistry", model: "fixture/fixture-think", options: [{ id: "thinking", value: "low" }] };
const policy = { cwd, runtimeMode: "approval-required", interactionMode: "default" };
const environment = { HOME: process.env.HOME, PATH: process.env.PATH, PI_SKIP_VERSION_CHECK: "1" };
const node = Layer.merge(NodeServices.layer, NodeCrypto.layer);
const alias = "litellm/openai/gpt-6.2-sol";
const services = Layer.mergeAll(node, IdAllocator.layer, McpProviderSessions.layer,
	TestProviderHost.layer({ cwd: "/", runBackgroundWork: false }).pipe(Layer.provide(node)),
	Layer.succeed(HostProcess.Environment, environment),
	Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, ProviderEventLoggers.NoOpProviderEventLoggers),
	Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("Unexpected registry HTTP request."))));
const layer = Registry.layerFromHost.pipe(Layer.provideMerge(services));
const settings = Schema.decodeUnknownSync(AcpRegistrySettings)({
	source: "local", commandPath: binary, commandArgs: ["acp", "--sandbox=workspace-write"],
});

const probeSettings = Effect.gen(function* () {
	for (const directory of ["/", process.env.HOME, cwd]) {
		const learned = new Map();
		const { probe, slashCommands, skills } = yield* probeAcpRegistryConfiguration({
			instanceId: selection.instanceId, settings, environment, cwd: directory,
			modelDiscovery: {
				onProbed: () => Effect.succeed(["fixture/fixture-think"]),
				onDiscovered: (state) => Effect.sync(() => learned.set(state.currentModelId, state.configOptions)),
			},
		});
		assert.ok(probe.ready && probe.sessionManagement.canDelete && !probe.sessionManagement.canLoad);
		assert.equal(probe.currentModelId, "fixture/fixture-one");
		assert.deepEqual(new Set(probe.models.map(({ id }) => id)),
			new Set(["fixture/fixture-one", "fixture/fixture-think", alias]));
		assert.ok(learned.get("fixture/fixture-think")?.some((option) =>
			option.id === "thinking" && option.options?.some(({ id }) => id === "low")));
		assert.deepEqual(slashCommands, []);
		assert.deepEqual(skills.map(({ name, path }) => [name, path]).sort(), [
			["ego-browser", "acp://skill/ego-browser"], ["personal-notes", "acp://skill/personal-notes"],
			["shared-notes", "acp://skill/shared-notes"], ["standard-notes", "acp://skill/standard-notes"],
		]);
		assert.equal(skills.find(({ name }) => name === "ego-browser")?.description,
			mode === "pending-probe" ? "External personal skill · approval required before use" : "External fixture");
		assert.ok(skills.every(({ description }) => description !== "Unapproved duplicate"));
	}
	console.log("PASS: real pinned T3 Settings probe discovered the configured models and per-model effort from /, HOME and the project.");
}).pipe(Effect.provide(layer));

const settingsSnapshot = Effect.gen(function* () {
	const instanceId = selection.instanceId;
	const host = yield* ProviderHost.ProviderHost;
	const cached = yield* makeAcpRegistryLearnedModelOptionsStore({
		cacheDir: host.paths.providerStatusCacheDir, instanceId, settings,
	});
	assert.ok(version);
	yield* cached.setVersion(version);
	const off = { id: "thinking", label: "Thinking", type: "select", role: "reasoning",
		currentValue: "off", options: [{ id: "off", label: "off" }] };
	yield* cached.learn(alias, [off], "live");
	assert.deepEqual((yield* cached.get).get(alias), [off]);

	const driver = yield* AcpRegistryDriver.create({
		instanceId, displayName: "Codey ACP fixture", enabled: true, environment: [], config: settings,
	});
	const next = yield* driver.snapshot.streamChanges.pipe(
		Stream.filter((snapshot) => snapshot.status === "ready" && snapshot.models.some(({ slug }) => slug === alias)),
		Stream.runHead, Effect.forkScoped({ startImmediately: true }),
	);
	yield* driver.snapshot.refresh;
	const snapshot = (yield* Fiber.join(next)).value;
	assert.equal(snapshot.skills?.find(({ name }) => name === "ego-browser")?.description,
		mode === "pending-probe" ? "External personal skill · approval required before use" : "External fixture");
	const direct = snapshot.models.find(({ slug }) => slug === "fixture/fixture-one");
	const custom = snapshot.models.find(({ slug }) => slug === alias);
	const options = (model) => model.capabilities.optionDescriptors.find(({ id }) => id === "thinking").options.map(({ id }) => id);
	assert.equal(direct.isDefault, true);
	assert.deepEqual(options(direct), ["off"]);
	assert.equal(custom.isDefault ?? false, false);
	assert.deepEqual(options(custom), ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.equal(custom.name, "openai/gpt-6.2-sol");
	// This pinned registry projects known model fields and drops the ACP display extension.
	assert.equal(custom.subProvider, undefined);
	console.log("PASS: real T3 Local ACP driver snapshot replaced stale off-only metadata for the non-default alias before a turn.");
}).pipe(Effect.scoped, Effect.provide(layer));

function localCommand(fn, initialNativeThreadId) {
	return Effect.gen(function* () {
		const mcp = yield* McpProviderSessions.McpProviderSessions;
		// Simulate the server attaching its normal bridge, but its process must never run.
		yield* mcp.set({ threadId, endpoint: "http://127.0.0.1:1/fixture", authorizationHeader: "Bearer fake-t3-token" });
		const adapter = yield* makeAcpRegistryAdapterV2({
			instanceId: selection.instanceId, environment,
			settings,
			selfInvocation: { command: "/usr/bin/false" },
		});
		const runtime = yield* adapter.openSession({
			threadId, providerSessionId: "provider-session:codey-acp-fixture",
			modelSelection: selection, runtimePolicy: policy,
			...(initialNativeThreadId ? { initialNativeThreadId } : {}),
		});
		return yield* fn(runtime);
	}).pipe(Effect.scoped, Effect.provide(layer));
}

function send(runtime, providerThread, text, ordinal, { interrupt = false, expected, inlineContextLength, reply } = {}) {
	return Effect.gen(function* () {
		let turnId;
		let displayed = false;
		const terminal = yield* runtime.events.pipe(Stream.tap((event) => Effect.gen(function* () {
			displayed ||= expected !== undefined && JSON.stringify(event).includes(expected);
			if (reply && event.type === "turn_item.updated" && event.turnItem.type === "user_input_request" &&
				event.turnItem.status === "waiting") {
				const answer = reply;
				reply = undefined;
				const item = event.turnItem;
				assert.equal(item.questions.length, 1);
				const [question] = item.questions;
				assert.equal(question.question, "Which output format?");
				assert.ok(question.options.some(({ label, description }) => label === "Markdown [Recommended]" && description === "Readable text"));
				assert.notEqual(question.allowCustomAnswer, false);
				yield* runtime.respondToRuntimeRequest({ requestId: item.requestId, answers: { [question.id]: answer } }).pipe(Effect.forkScoped);
			}
			if (event.providerTurn?.id && event.providerTurn.ordinal === ordinal) turnId = event.providerTurn.id;
			if (interrupt && turnId && JSON.stringify(event).includes("SLOW_STARTED")) {
				interrupt = false;
				yield* runtime.interruptTurn({ providerThread, providerTurnId: turnId });
			}
		})), Stream.filter((event) => event.type === "turn.terminal"),
			Stream.runHead, Effect.forkScoped);
		const runId = `run:codey-acp-fixture:${ordinal}`;
		yield* runtime.startTurn({
			appThread: { id: threadId, title: "Codey ACP fixture" },
			threadId, runId, runOrdinal: ordinal, providerTurnOrdinal: ordinal,
			attemptId: `attempt:${runId}`, rootNodeId: `node:${runId}`, providerThread,
			message: { messageId: `message:${runId}`, text, attachments: [], createdBy: "user", creationSource: "web" },
			...(inlineContextLength === undefined ? {} : { inlineContextLength }),
			modelSelection: selection, runtimePolicy: policy,
		});
		const result = yield* Fiber.await(terminal);
		assert.equal(result._tag, "Success", JSON.stringify(result));
		if (expected) assert.ok(displayed, `T3 did not receive ${expected}`);
		return result.value.value?.status;
	});
}

const chat = Effect.gen(function* () {
	const first = yield* localCommand((runtime) => Effect.gen(function* () {
		const coordinator = yield* AcpRegistryRuntimeCoordinator;
		const thread = yield* runtime.ensureThread({ threadId, modelSelection: selection, runtimePolicy: policy });
		const commands = yield* coordinator.getAvailableCommands(selection.instanceId).pipe(
			Effect.repeat({ until: (value) => value._tag === "Some", times: 200, schedule: Schedule.spaced("25 millis") }),
		);
		assert.equal(commands._tag, "Some");
		assert.deepEqual(commands.value.skills.map(({ name }) => name), [
			"ego-browser", "personal-notes", "shared-notes", "standard-notes", "project-skills",
		]);
		// ChatComposer's skill selection inserts `$${item.skill.name} `. The first
		// real adapter turn also adds its orchestration wrapper and runtime block.
		assert.equal(yield* send(runtime, thread, "$project-notes t3-acp-first", 1), "completed");
		assert.equal(yield* send(runtime, thread, "$project-skills", 2, { expected: "$openspec-verify-change" }), "completed");
		assert.equal(yield* send(runtime, thread, "$openspec-verify-change fresh-local", 3), "completed");
		return thread;
	}));
	const nativeId = first.nativeThreadRef?.nativeId;
	assert.ok(nativeId && !nativeId.includes("/"), nativeId);
	yield* localCommand((runtime) => Effect.gen(function* () {
		const second = yield* runtime.resumeThread({ providerThread: first });
		assert.equal(second.nativeThreadRef?.nativeId, nativeId);
		assert.equal(yield* send(runtime, second, "$standard-notes t3-acp-second", 4), "completed");
		assert.equal(yield* send(runtime, second, "slow fixture", 5, { interrupt: true }), "interrupted");
	}), nativeId);
	console.log("PASS: pinned T3 Local command adapter negotiated ACP v1, prompted, cold-resumed and cancelled a turn.");
});

const pendingChat = localCommand((runtime) => Effect.gen(function* () {
	const thread = yield* runtime.ensureThread({ threadId, modelSelection: selection, runtimePolicy: policy });
	const expected = "codey acp skills inspect ego-browser";
	assert.equal(yield* send(runtime, thread, "$ego-browser ", 1, { expected }), "completed");
	assert.equal(yield* send(runtime, thread, "Apply $ego-browser here", 2, { expected }), "completed");
	console.log("PASS: pinned T3 Local ACP received local approval instructions for pending skill selections.");
}));

function sendHandoff(runtime, providerThread, userText, ordinal, historyText, { expected, condensed = false } = {}) {
	return Effect.gen(function* () {
		const message = { itemId: `item:history-${ordinal}`, role: "user", threadId, runId: "run:original-pi",
			providerThreadId: "thread:original-pi", status: "completed", kind: "user_message", text: historyText };
		const coveredRunOrdinals = { from: 1, to: 1 };
		const coverage = handoffCoverage({ threadId, coveredRunOrdinals, items: [{ id: message.itemId }] });
		const delivery = yield* deliverContextHandoffs({
			handoffs: [{ threadId, strategy: "full_thread_summary", coveredRunOrdinals,
				history: { messages: [message], omittedItems: 0, coverage: condensed ? `${coverage}\n${"F".repeat(5000)}` : coverage } }],
			providerThread, alreadyDeliveredItemIds: new Set(), budget: 16_000, persist: () => Effect.void,
		});
		const text = withInlineContext(delivery.context, userText);
		const header = condensed ? "Context handoff (full_thread_summary). 1 handoff records;" : "Context handoff (full_thread_summary):\n";
		assert.ok(text.startsWith(header) && text.includes(historyText));
		assert.equal(yield* send(runtime, providerThread, text, ordinal,
			{ expected, inlineContextLength: text.length - userText.length }), "completed");
		yield* delivery.delivered;
	});
}

const handoff = Effect.gen(function* () {
	const first = yield* localCommand((runtime) => Effect.gen(function* () {
		const thread = yield* runtime.ensureThread({ threadId, modelSelection: selection, runtimePolicy: policy });
		yield* sendHandoff(runtime, thread, "$project-skills", 1, "LIST_HANDOFF_HISTORY $personal-notes and $project-skills", { expected: "$openspec-verify-change" });
		return thread;
	}));
	// A new ACP process must retain the first turn's historical context even though it was a local list.
	yield* localCommand((runtime) => Effect.gen(function* () {
		const thread = yield* runtime.resumeThread({ providerThread: first });
		assert.equal(yield* send(runtime, thread, "$openspec-verify-change after-list", 2), "completed");
	}), first.nativeThreadRef.nativeId);
	yield* localCommand((runtime) => Effect.gen(function* () {
		const thread = yield* runtime.ensureThread({ threadId, modelSelection: selection, runtimePolicy: policy });
		yield* sendHandoff(runtime, thread, "$standard-notes after-handoff", 1, "PERSONAL_HANDOFF_HISTORY $project-skills $personal-notes");
		yield* sendHandoff(runtime, thread, "Current ordinary text AMBIGUOUS_HISTORY_CHECK", 2, "Quoted marker:\n\nUser message:\n$personal-notes");
		assert.equal(yield* send(runtime, thread, "Typed marker only:\n\nUser message:\n$project-skills FAKE_MARKER_CHECK", 3), "completed");
		yield* sendHandoff(runtime, thread, "Current marker example:\n\nUser message:\n$standard-notes CURRENT_MARKER_CHECK", 4, "Old dollar token $personal-notes");
		yield* sendHandoff(runtime, thread, "$openspec-verify-change condensed-context", 5, "CONDENSED_HANDOFF_HISTORY $personal-notes", { condensed: true });
	}));
	console.log("PASS: pinned T3 handoff delivery listed skills locally, retained history on cold resume, and routed only the current unambiguous skill.");
});

const questions = localCommand((runtime) => Effect.gen(function* () {
	const thread = yield* runtime.ensureThread({ threadId, modelSelection: selection, runtimePolicy: policy });
	assert.equal(yield* send(runtime, thread, "option fixture", 1, { reply: "markdown", expected: "CONFIRMED_ANSWER" }), "completed");
	assert.equal(yield* send(runtime, thread, "custom fixture", 2, { reply: "CSV please", expected: "CONFIRMED_ANSWER" }), "completed");
	assert.equal(yield* send(runtime, thread, "mixed fixture", 3, { expected: "No action was taken." }), "completed");
	console.log("PASS: pinned T3 Local ACP renders separate question items, returns explicit choice and custom answers, and receives mixed-batch rejection as text.");
}));

const scenario = mode === "question" ? questions : mode === "pending-chat" ? pendingChat : mode === "probe" || mode === "pending-probe"
	? settingsSnapshot.pipe(Effect.andThen(probeSettings)) : chat.pipe(Effect.andThen(handoff));
await Effect.runPromise(scenario
	.pipe(Effect.timeout("210 seconds")));
