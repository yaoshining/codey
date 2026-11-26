// Check the public flag route and isolation of the existing CLI entry points.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	const rpc = invoke("--mode", "rpc", "--sandbox", "workspace-write", "--extension", "/not/a/trusted/extension.ts");
	assert.equal(rpc.status, 1, rpc.stderr);
	assert.equal(rpc.stdout, "");
	assert.match(rpc.stderr, /Extensions are unavailable/);
	if (process.platform !== "darwin") {
		const missingBackend = invoke("--sandbox", "workspace-write", "--mode", "rpc");
		assert.equal(missingBackend.status, 1, missingBackend.stderr);
		assert.equal(missingBackend.stdout, "");
		assert.match(missingBackend.stderr, /requires macOS Seatbelt/);
	}
	const run = invoke("--sandbox", "workspace-write");
	assert.equal(run.status, 1, run.stderr);
	assert.match(run.stderr, /requires macOS Seatbelt|interactive Codey terminal/);
});

test("Codey manages exact HTTPS hostnames per canonical workspace", (t) => {
	const root = mkdtempSync(join(tmpdir(), "codey-domains-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const name of ["home", "one", "two"]) mkdirSync(join(root, name));
	symlinkSync(join(root, "one"), join(root, "alias"));
	function domain(project, ...args) {
		return spawnSync(codey, ["--sandbox", "workspace-write", "--workspace", join(root, project), ...args], {
			encoding: "utf8", timeout: 20_000, env: { HOME: join(root, "home"), PATH: process.env.PATH },
		});
	}
	assert.match(domain("one", "--list-domains").stdout, /No HTTPS domains/);
	assert.equal(domain("one", "--allow-domain", "DOCS.example.org").status, 0);
	assert.equal(domain("alias", "--list-domains").stdout.trim(), "docs.example.org");
	assert.match(domain("two", "--list-domains").stdout, /No HTTPS domains/);
	assert.equal(domain("one", "--allow-domain", "*.example.org").status, 1);
	assert.equal(domain("one", "--allow-domain", "http://docs.example.org").status, 1);
	assert.equal(domain("home", "--allow-domain", "docs.example.org").status, 1);
	assert.equal(domain("alias", "--remove-domain", "docs.example.org").status, 0);
	assert.match(domain("one", "--list-domains").stdout, /No HTTPS domains/);
});
