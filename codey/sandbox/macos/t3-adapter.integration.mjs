// Copy this fixture into packages/provider-pi of yaoshining/t3code at a22a4f9bba5d3e93ef673014549f83fd915f9677.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { makePiAdapterV2 } from "./src/server/adapter.ts";

const [binary, cwd] = process.argv.slice(2);
const threadId = "thread:codey-sandbox-fixture";
const modelSelection = { instanceId: "pi", model: "fixture/fixture-one" };
const runtimePolicy = { runtimeMode: "full-access", interactionMode: "default", cwd };
const recipe = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer,
	TestProviderHost.layer({ cwd }).pipe(Layer.provide(NodeServices.layer)));

const withAdapter = (fn, { sandbox = true, initialNativeThreadId } = {}) => Effect.gen(function* () {
	const adapter = yield* makePiAdapterV2({
		instanceId: "pi",
		settings: { enabled: true, binaryPath: binary, launchArgs: sandbox ? "--offline --sandbox=workspace-write" : "--offline", customModels: [] },
		environment: { HOME: process.env.HOME, PATH: process.env.PATH, PI_SKIP_VERSION_CHECK: "1" },
	});
	const runtime = yield* adapter.openSession({
		threadId, providerSessionId: "provider-session:codey-sandbox-fixture", modelSelection, runtimePolicy,
		...(initialNativeThreadId ? { initialNativeThreadId } : {}),
	});
	return yield* fn(runtime);
}).pipe(Effect.scoped, Effect.provide(recipe));

const register = (runtime) => runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
const pathFor = (thread) => thread.nativeThreadRef.nativeId;
const send = (runtime, providerThread, text, ordinal) => Effect.gen(function* () {
	const terminal = yield* runtime.events.pipe(
		Stream.filter((event) => event.type === "turn.terminal"),
		Stream.runHead,
		Effect.forkScoped,
	);
	const runId = `run:sandbox-fixture:${ordinal}`;
	yield* runtime.startTurn({
		appThread: { id: threadId, title: "Codey sandbox fixture" },
		threadId, runId, runOrdinal: ordinal, providerTurnOrdinal: ordinal,
		attemptId: `attempt:${runId}`, rootNodeId: `node:${runId}`, providerThread,
		message: { messageId: `message:${runId}`, text, attachments: [], createdBy: "user", creationSource: "web" },
		modelSelection, runtimePolicy,
	});
	const result = yield* Fiber.await(terminal);
	assert.equal(result._tag, "Success", JSON.stringify(result));
	assert.equal(result.value.value?.status, "completed", JSON.stringify(result));
});

await Effect.runPromise(Effect.gen(function* () {
	// Adapter persists a native ref during ensureThread, before the first prompt.
	const empty = yield* withAdapter(register);
	const file = pathFor(empty);
	assert.match(file, /\/sandbox-rpc\//);
	const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
	assert.equal(header.cwd, cwd);
	assert.equal(header.type, "session");

	// Reopen the registered blank thread with T3's RPC switch path, then write history.
	const first = yield* withAdapter((runtime) => Effect.gen(function* () {
		const resumed = yield* runtime.resumeThread({ providerThread: empty });
		assert.equal(pathFor(resumed), file);
		yield* send(runtime, resumed, "t3-fixture-first", 1);
		return resumed;
	}));
	// Also exercise T3's launch optimization that passes --session before its get_state probe.
	yield* withAdapter((runtime) => Effect.gen(function* () {
		const resumed = yield* runtime.resumeThread({ providerThread: first });
		assert.equal(pathFor(resumed), file);
		yield* send(runtime, resumed, "t3-fixture-second", 2);
	}), { initialNativeThreadId: file });
	assert.match(readFileSync(file, "utf8"), /t3-fixture-first/);
	assert.match(readFileSync(file, "utf8"), /t3-fixture-second/);
	console.log("PASS: pinned T3 adapter registered a blank sandbox chat, restored it over RPC, then reopened its history via --session.");

	const ordinary = yield* withAdapter((runtime) => Effect.gen(function* () {
		const thread = yield* register(runtime);
		yield* send(runtime, thread, "t3-fixture-ordinary", 3);
		return thread;
	}), { sandbox: false });
	const legacy = pathFor(ordinary);
	assert.doesNotMatch(legacy, /\/sandbox-rpc\//);
	const original = readFileSync(legacy);
	for (const initialNativeThreadId of [undefined, legacy]) {
		const failed = yield* withAdapter(
			(runtime) => runtime.resumeThread({ providerThread: ordinary }),
			{ initialNativeThreadId },
		).pipe(Effect.result);
		assert.equal(failed._tag, "Failure");
		const diagnostics = [];
		for (let cause = failed.failure; cause && diagnostics.length < 8; cause = cause.cause) diagnostics.push(String(cause));
		const diagnostic = diagnostics.join(" | ");
		console.log(`T3 adapter legacy resume (${initialNativeThreadId ? "startup --session" : "RPC switch"}): ${diagnostic}`);
		assert.match(diagnostic, /Start a new, empty T3 chat/);
		assert.deepEqual(readFileSync(legacy), original);
	}
	console.log("PASS: pinned T3 adapter rejected the ordinary chat and preserved its original file.");
}).pipe(Effect.timeout("100 seconds")));
