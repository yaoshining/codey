// Run from packages/provider-acp-registry in the pinned T3 source checkout.
import assert from "node:assert/strict";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import { AcpRegistryDriver } from "./src/server/driver.ts";
import { makeAcpRegistryLearnedModelOptionsStore } from "./src/server/learnedModelOptions.ts";
import { probeAcpRegistryConfiguration } from "./src/server/probe.ts";

const [binary, cwd, mode, version] = process.argv.slice(2);
const threadId = "thread:codey-acp-fixture";
const selection = { instanceId: "acpRegistry", model: "fixture/fixture-think", options: [{ id: "thinking", value: "low" }] };
const policy = { cwd, runtimeMode: "approval-required", interactionMode: "default" };
const environment = { HOME: process.env.HOME, PATH: process.env.PATH, PI_SKIP_VERSION_CHECK: "1" };
const node = Layer.merge(NodeServices.layer, NodeCrypto.layer);
const alias = "litellm/openai/fixture-one";
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
		assert.deepEqual([slashCommands, skills], [[], []]);
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
	const direct = snapshot.models.find(({ slug }) => slug === "fixture/fixture-one");
	const custom = snapshot.models.find(({ slug }) => slug === alias);
	const options = (model) => model.capabilities.optionDescriptors.find(({ id }) => id === "thinking").options.map(({ id }) => id);
	assert.equal(direct.isDefault, true);
	assert.deepEqual(options(direct), ["off"]);
	assert.equal(custom.isDefault ?? false, false);
	assert.deepEqual(options(custom), ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.equal(custom.name, "openai/fixture-one");
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

const chat = Effect.gen(function* () {
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
});
await Effect.runPromise((mode === "probe" ? settingsSnapshot.pipe(Effect.andThen(probeSettings)) : chat)
	.pipe(Effect.timeout("120 seconds")));
