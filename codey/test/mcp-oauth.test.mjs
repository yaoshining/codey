// Keep Pi's automatic MCP OAuth selection when using the real Codey command.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const executable = resolve(process.env.CODEY_TEST_BIN ?? join(root, "codey/bin/codey"));
const runtimeRoot = resolve(dirname(realpathSync(executable)), "../..");
const supported = process.platform === "linux" || process.platform === "darwin";
const mockUrl = new URL("./fixtures/mcp-oauth-mock.mjs", import.meta.url).href;

function fixture(t, serverKind, registration) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "codey-mcp-oauth-")));
	const attempts = join(directory, "external-socket-attempts");
	t.after(() => {
		try {
			assert.equal(existsSync(attempts), false, "MCP test attempted an external socket connection");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	const home = join(directory, "home ' #?%");
	const agent = join(home, ".codey/agent");
	const cwd = join(directory, "project with spaces");
	const bin = join(directory, "bin");
	const log = join(directory, "requests.jsonl");
	for (const path of [agent, cwd, bin]) mkdirSync(path, { recursive: true });
	writeFileSync(log, "");
	symlinkSync(executable, join(bin, "codey"));
	writeFileSync(
		join(agent, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				fixture: {
					url: "https://mcp.codey-fixture.invalid/mcp",
					...(registration === "auto" ? { oauth: { clientRegistration: "auto" } } : {}),
				},
			},
		}),
	);

	// Load the tested runtime's dispatcher first so normal setup preserves mocked fetch.
	// Resolving from CODEY_TEST_BIN also covers a separately installed checkout.
	const preload = join(directory, "preload.mjs");
	const dispatcher = pathToFileURL(join(runtimeRoot, "packages/coding-agent/src/core/http-dispatcher.ts")).href;
	writeFileSync(
		preload,
		`import { configureHttpDispatcher } from ${JSON.stringify(dispatcher)};\nimport ${JSON.stringify(mockUrl)};\nvoid configureHttpDispatcher;\n`,
	);

	// Pi uses `open` on macOS and `xdg-open` on Linux. Both resolve to this recorder.
	// It never visits the authorization host; it completes only the local fixture callback.
	const browserSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { get } from "node:http";
const authorization = new URL(process.argv[2]);
if (authorization.origin !== "https://auth.codey-fixture.invalid") throw new Error("Unexpected fixture authorization origin");
appendFileSync(process.env.CODEY_MCP_LOG, JSON.stringify({ type: "browser", clientId: authorization.searchParams.get("client_id") }) + "\\n");
const callback = new URL(authorization.searchParams.get("redirect_uri"));
if (callback.hostname !== "127.0.0.1") throw new Error("Only the fixture's loopback callback is allowed");
callback.searchParams.set("code", "codey-fixture-authorization-code");
callback.searchParams.set("state", authorization.searchParams.get("state"));
callback.searchParams.set("iss", "https://auth.codey-fixture.invalid");
get(callback, response => response.resume()).on("error", error => {
  appendFileSync(process.env.CODEY_MCP_LOG, JSON.stringify({ type: "browser_error", message: error.message }) + "\\n");
});
`;
	for (const name of ["open", "xdg-open"]) {
		const path = join(bin, name);
		writeFileSync(path, browserSource);
		chmodSync(path, 0o755);
	}
	return {
		agent,
		home,
		cwd,
		log,
		env: {
			PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
			HOME: home,
			TERM: "dumb",
			NO_COLOR: "1",
			PI_OFFLINE: "1",
			PI_CODING_AGENT_DIR: agent,
			CODEY_CODING_AGENT_DIR: agent,
			CODEY_MCP_SERVER_KIND: serverKind,
			CODEY_MCP_LOG: log,
			CODEY_MCP_EXTERNAL_ATTEMPTS: attempts,
			NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
		},
	};
}

for (const serverKind of ["cimd-only", "dcr-only"]) {
	for (const registration of ["omitted", "auto"]) {
		test(
			`real Codey MCP login preserves Pi ${registration} OAuth selection for ${serverKind}`,
			{ timeout: 35_000, skip: supported ? false : "The Codey shell entry supports macOS and Linux" },
			(t) => {
				const context = fixture(t, serverKind, registration);
				const result = spawnSync("codey", ["mcp", "login", "fixture", "--timeout", "10"], {
					cwd: context.cwd,
					env: context.env,
					encoding: "utf8",
					input: "",
					timeout: 30_000,
				});
				assert.ifError(result.error);
				assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
				assert.match(result.stdout, /Signed in to MCP server "fixture" \(0 tools\)/);
				const events = readFileSync(context.log, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				assert.equal(
					events.some((event) => event.type === "unmocked" || event.type === "browser_error"),
					false,
				);
				const registrations = events.filter((event) => event.type === "registration");
				const browsers = events.filter((event) => event.type === "browser");
				assert.equal(browsers.length, 1);
				const clientId =
					serverKind === "cimd-only" ? "https://pi.dev/oauth/client.json" : "codey-fixture-registered-client";
				assert.equal(browsers[0].clientId, clientId);
				if (serverKind === "cimd-only") {
					assert.deepEqual(registrations, []);
				} else {
					assert.equal(registrations.length, 1);
					assert.equal(registrations[0].metadata.client_name, "pi");
				}
				const tokens = events.filter((event) => event.type === "token");
				assert.deepEqual(tokens, [{ type: "token", clientId, grantType: "authorization_code" }]);
				assert.equal(existsSync(join(context.agent, "mcp-auth.json")), true);
				assert.equal(existsSync(join(context.home, ".pi")), false);
			},
		);
	}
}
