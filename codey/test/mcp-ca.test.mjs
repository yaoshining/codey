// Drive the Codey MCP extension against a loopback TLS server with a synthetic certificate.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const codey = resolve(process.env.CODEY_TEST_BIN ?? fileURLToPath(new URL("../bin/codey", import.meta.url)));

test("Codey applies a custom MCP CA only to the named endpoint and still validates the IP SAN", { timeout: 45_000 }, async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "codey-mcp-ca-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const agent = join(home, ".codey/agent");
	const cert = join(agent, "mcp-cas/fixture.pem");
	const key = join(root, "fixture-key");
	const cwd = join(root, "project");
	mkdirSync(dirname(cert), { recursive: true });
	mkdirSync(cwd);
	const openssl = join(root, "fixture.cnf");
	writeFileSync(openssl, "[req]\ndistinguished_name=dn\n[dn]\n[fixture]\nsubjectAltName=IP:127.0.0.1\n");
	execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
		"-subj", "/CN=Codey fixture", "-config", openssl, "-extensions", "fixture", "-keyout", key, "-out", cert], { stdio: "pipe" });
	const initialized = [];
	const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (req, res) => {
		if (req.method !== "POST") return res.writeHead(405).end();
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const message = JSON.parse(raw);
		if (message.method === "initialize") {
			initialized.push(req.url);
			return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
				jsonrpc: "2.0", id: message.id,
				result: { protocolVersion: message.params.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: {} },
			}));
		}
		res.writeHead(202).end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	const { port } = server.address();
	const urls = {
		approved: `https://127.0.0.1:${port}/approved`,
		untrusted: `https://127.0.0.1:${port}/untrusted`,
		wrong_san: `https://localhost:${port}/wrong-san`,
	};
	writeFileSync(join(agent, "mcp.json"), JSON.stringify({
		mcpServers: Object.fromEntries(Object.entries(urls).map(([name, url]) => [name, { url, headers: { Authorization: "Bearer fake" } }])),
	}));
	writeFileSync(join(agent, "mcp-ca.json"), JSON.stringify({
		approved: { url: urls.approved, caFile: "fixture.pem" },
		wrong_san: { url: urls.wrong_san, caFile: "fixture.pem" },
	}));
	const child = spawn(codey, ["--mode", "rpc", "--no-session", "--offline"], {
		cwd, timeout: 35_000, env: { HOME: home, PATH: process.env.PATH, TERM: "dumb", NO_COLOR: "1" },
	});
	const closed = once(child, "close");
	let diagnostics = "";
	child.stderr.setEncoding("utf8").on("data", (chunk) => { diagnostics += chunk; });
	const status = () => child.stdin.write(`${JSON.stringify({ id: "mcp", type: "prompt", message: "/mcp" })}\n`);
	status();
	let report;
	try {
		for await (const line of createInterface({ input: child.stdout })) {
			const event = JSON.parse(line);
			if (event.type === "extension_ui_request" && event.method === "notify" && event.message.includes("untrusted:")) {
				report = event.message;
				if (/approved: connected/.test(report) && /untrusted: failed/.test(report) && /wrong_san: failed/.test(report)) break;
			}
			if (event.type === "response" && event.id === "mcp") {
				assert.equal(event.success, true, line);
				await new Promise((done) => setTimeout(done, 200));
				status();
			}
		}
	} finally {
		child.stdin.end();
		const [exit] = await closed;
		assert.equal(exit, 0, `${diagnostics}\n${report ?? ""}`);
	}
	assert.match(report, /approved: connected/);
	assert.match(report, /untrusted: failed[^\n]*\n\s+MCP TLS certificate is untrusted/);
	assert.match(report, /wrong_san: failed[^\n]*\n\s+MCP TLS identity mismatch/);
	assert.deepEqual(initialized, ["/approved"]);
});
