// Check the public flag route and isolation of the existing CLI entry points.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const codey = fileURLToPath(new URL("../bin/codey", import.meta.url));
const invoke = (...args) => spawnSync(codey, args, { encoding: "utf8", timeout: 20_000 });

test("the macOS and Docker help commands have distinct entry points", () => {
	const mac = invoke("--sandbox=workspace-write", "--help");
	assert.equal(mac.status, 0, mac.stderr);
	assert.match(mac.stdout, /Seatbelt/);
	const docker = invoke("sandbox", "--help");
	assert.equal(docker.status, 0, docker.stderr);
	assert.match(docker.stdout, /--image/);
});

test("unsupported sandbox options cannot fall through to ordinary Codey", () => {
	const mode = invoke("--sandbox", "other-mode");
	assert.equal(mode.status, 1, mode.stderr);
	assert.match(mode.stderr, /Codey macOS sandbox/);
	const rpc = invoke("--mode", "rpc", "--sandbox", "workspace-write");
	assert.equal(rpc.status, 1, rpc.stderr);
	assert.match(rpc.stderr, /Codey macOS sandbox/);
	const run = invoke("--sandbox", "workspace-write");
	assert.equal(run.status, 1, run.stderr);
	assert.match(run.stderr, /requires macOS Seatbelt|interactive Codey terminal/);
});
