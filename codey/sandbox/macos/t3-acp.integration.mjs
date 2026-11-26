// Run from packages/provider-acp-registry in the pinned T3 source checkout.
import assert from "node:assert/strict";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as Registry from "./src/server/AcpRegistrySupport.ts";
import { AcpRegistrySettings } from "./src/settings.ts";
import { makeAcpRegistryAdapterV2 } from "./src/server/adapter.ts";

const [binary, cwd] = process.argv.slice(2);
const threadId = "thread:codey-acp-fixture";
const selection = { instanceId: "acpRegistry", model: "fixture/fixture-think", options: [{ id: "thinking", value: "low" }] };
const policy = { cwd, runtimeMode: "approval-required", interactionMode: "default" };
const environment = { HOME: process.env.HOME, PATH: process.env.PATH, PI_SKIP_VERSION_CHECK: "1" };
const node = Layer.merge(NodeServices.layer, NodeCrypto.layer);
const services = Layer.mergeAll(node, IdAllocator.layer, McpProviderSessions.layer,
	TestProviderHost.layer({ cwd }).pipe(Layer.provide(node)),
	Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("Unexpected registry HTTP request."))));
const layer = Registry.layerFromHost.pipe(Layer.provideMerge(services));

function localCommand(fn, initialNativeThreadId) {
	return Effect.gen(function* () {
		const mcp = yield* McpProviderSessions.McpProviderSessions;
		// Simulate the server attaching its normal bridge, but its process must never run.
		yield* mcp.set({ threadId, endpoint: "http://127.0.0.1:1/fixture", authorizationHeader: "Bearer fake-t3-token" });
		const adapter = yield* makeAcpRegistryAdapterV2({
			instanceId: selection.instanceId, environment,
			settings: Schema.decodeUnknownSync(AcpRegistrySettings)({
				source: "local", commandPath: binary, commandArgs: ["acp", "--sandbox=workspace-write"],
			}),
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

function send(runtime, providerThread, text, ordinal, interrupt = false) {
	return Effect.gen(function* () {
		let turnId;
		const terminal = yield* runtime.events.pipe(Stream.tap((event) => Effect.gen(function* () {
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
			modelSelection: selection, runtimePolicy: policy,
		});
		const result = yield* Fiber.await(terminal);
		assert.equal(result._tag, "Success", JSON.stringify(result));
		return result.value.value?.status;
	});
}

await Effect.runPromise(Effect.gen(function* () {
	const first = yield* localCommand((runtime) => Effect.gen(function* () {
		const thread = yield* runtime.ensureThread({ threadId, modelSelection: selection, runtimePolicy: policy });
		assert.equal(yield* send(runtime, thread, "t3-acp-first", 1), "completed");
		return thread;
	}));
	const nativeId = first.nativeThreadRef?.nativeId;
	assert.ok(nativeId && !nativeId.includes("/"), nativeId);
	yield* localCommand((runtime) => Effect.gen(function* () {
		const second = yield* runtime.resumeThread({ providerThread: first });
		assert.equal(second.nativeThreadRef?.nativeId, nativeId);
		assert.equal(yield* send(runtime, second, "t3-acp-second", 2), "completed");
		assert.equal(yield* send(runtime, second, "slow fixture", 3, true), "interrupted");
	}), nativeId);
	console.log("PASS: pinned T3 Local command adapter negotiated ACP v1, prompted, cold-resumed and cancelled a turn.");
}).pipe(Effect.timeout("120 seconds")));
