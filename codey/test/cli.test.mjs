// Checks the Codey entry and installer without contacting model providers.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wrapper = join(repository, "codey/bin/codey");
const installer = join(repository, "codey/install.sh");
const revision = "0123456789abcdef0123456789abcdef01234567";

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "codey-cli-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const source = join(directory, "source checkout ' #?%");
	const bin = join(source, "codey/bin");
	const agent = join(source, "packages/coding-agent/src");
	const cwd = join(directory, "project with spaces");
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(agent, "experimental"), { recursive: true });
	mkdirSync(cwd);
	copyFileSync(wrapper, join(bin, "codey"));
	chmodSync(join(bin, "codey"), 0o755);
	writeFileSync(join(agent, "experimental/source-resolver.ts"), "// The test CLI needs no source aliases.\n");
	writeFileSync(
		join(agent, "cli.ts"),
		`if (process.argv.includes("--version")) {
	console.log("1.6.0");
	process.exit(0);
}
if (process.env.CODEY_TEST_WAIT === "1") {
	console.log(JSON.stringify({ pid: process.pid }));
	setInterval(() => {}, 1000);
} else {
	let input = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) input += chunk;
	process.stdout.write(JSON.stringify({
		args: process.argv.slice(2), cwd: process.cwd(), input,
		environment: process.env.CODEY_TEST_VALUE, pid: process.pid,
	}));
	process.stderr.write("fixture stderr\\n");
	process.exitCode = Number(process.env.CODEY_TEST_EXIT ?? 0);
}
`,
	);
	return { directory, source, cwd, entry: join(bin, "codey") };
}

function installFixture(t, shell = "/bin/zsh") {
	const fixturePaths = fixture(t);
	const { directory, source } = fixturePaths;
	const home = join(directory, "home ' #?%");
	const fakebin = join(directory, "fake tools");
	const log = join(directory, "commands.jsonl");
	const installDir = join(home, ".local/share/codey");
	const binDir = join(home, ".local/bin");
	const zshDir = join(home, "zsh config ' #?%");
	mkdirSync(fakebin);
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, "pi"), "existing Pi executable\n");
	writeFileSync(
		join(fakebin, "git"),
		`#!${process.execPath}
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const original = process.argv.slice(2);
appendFileSync(process.env.CODEY_TEST_LOG, JSON.stringify({ command: "git", args: original }) + "\\n");
const args = [...original];
let cwd = process.cwd();
if (args[0] === "-C") { args.shift(); cwd = args.shift(); }
const command = args.shift();
if (command === "init") {
	mkdirSync(join(args.at(-1), ".git"), { recursive: true });
} else if (command === "fetch") {
	writeFileSync(join(cwd, ".git/fetched"), args.at(-1));
} else if (command === "checkout") {
	cpSync(process.env.CODEY_TEST_SOURCE, cwd, { recursive: true });
	writeFileSync(join(cwd, ".git/head"), readFileSync(join(cwd, ".git/fetched")));
} else if (command === "rev-parse" && args[0] === "HEAD") {
	process.stdout.write(readFileSync(join(cwd, ".git/head")));
} else {
	console.error("Unexpected git command", original);
	process.exitCode = 9;
}
`,
	);
	writeFileSync(
		join(fakebin, "npm"),
		`#!${process.execPath}
import { appendFileSync, mkdirSync } from "node:fs";
appendFileSync(process.env.CODEY_TEST_LOG, JSON.stringify({ command: "npm", args: process.argv.slice(2) }) + "\\n");
if (process.env.CODEY_TEST_NPM_FAIL === "1") process.exit(43);
mkdirSync("node_modules", { recursive: true });
`,
	);
	chmodSync(join(fakebin, "git"), 0o755);
	chmodSync(join(fakebin, "npm"), 0o755);
	const environment = {
		...process.env,
		HOME: home,
		SHELL: shell,
		ZDOTDIR: zshDir,
		PATH: `${fakebin}:${process.env.PATH}`,
		CODEY_INSTALL_DIR: installDir,
		CODEY_BIN_DIR: binDir,
		CODEY_TEST_LOG: log,
		CODEY_TEST_SOURCE: source,
	};
	const run = (sha = revision, overrides = {}) =>
		spawnSync("bash", [installer, sha], {
			cwd: fixturePaths.cwd,
			env: { ...environment, ...overrides },
			encoding: "utf8",
		});
	const commands = () =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
	return { ...fixturePaths, home, installDir, binDir, zshDir, environment, run, commands };
}

test("entry forwards arguments, cwd, environment, stdin and output unchanged", (t) => {
	const { entry, cwd } = fixture(t);
	const args = ["--no-env", "--", "", "two words", "quote'\"", "#?%", "$(literal)", "line\nbreak"];
	const result = spawnSync(entry, args, {
		cwd,
		env: { ...process.env, CODEY_TEST_VALUE: "value with spaces", PI_OFFLINE: "1" },
		input: "input\nwith unicode: 世宁\n",
		encoding: "utf8",
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "fixture stderr\n");
	const output = JSON.parse(result.stdout);
	assert.deepEqual(output.args, args);
	assert.equal(output.cwd, cwd);
	assert.equal(output.environment, "value with spaces");
	assert.equal(output.input, "input\nwith unicode: 世宁\n");
});

test("entry resolves relative and absolute symlink chains in special-character paths", (t) => {
	const { directory, entry, cwd } = fixture(t);
	const links = join(directory, "links ' #?%");
	mkdirSync(links);
	symlinkSync(entry, join(links, "absolute target"));
	symlinkSync("absolute target", join(links, "codey"));
	const result = spawnSync(join(links, "codey"), ["--version"], { cwd, encoding: "utf8" });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "1.6.0\n");
});

test("entry preserves upstream nonzero exit status", (t) => {
	const { entry, cwd } = fixture(t);
	const result = spawnSync(entry, ["--unknown"], {
		cwd,
		env: { ...process.env, CODEY_TEST_EXIT: "27" },
		input: "",
		encoding: "utf8",
	});
	assert.ifError(result.error);
	assert.equal(result.status, 27);
	assert.equal(result.stderr, "fixture stderr\n");
	assert.deepEqual(JSON.parse(result.stdout).args, ["--unknown"]);
});

test("entry execs the CLI and delivers SIGTERM to the same process", { timeout: 10_000 }, async (t) => {
	const { entry, cwd } = fixture(t);
	const child = spawn(entry, [], {
		cwd,
		env: { ...process.env, CODEY_TEST_WAIT: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => child.kill("SIGKILL"));
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
	const ready = new Promise((resolveReady, reject) => {
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (output.includes("\n")) resolveReady(JSON.parse(output.split("\n")[0]));
		});
		child.once("error", reject);
		child.once("exit", () => reject(new Error(`CLI exited before readiness: ${stderr}`)));
	});
	const state = await ready;
	assert.equal(state.pid, child.pid);
	assert.equal(child.kill("SIGTERM"), true);
	assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
});

test("installer fetches the pinned revision, installs without lifecycle scripts and exposes codey", (t) => {
	const { run, commands, installDir, binDir, zshDir, environment, cwd } = installFixture(t);
	const result = run();
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readlinkSync(join(binDir, "codey")), join(installDir, revision, "codey/bin/codey"));
	assert.equal(readFileSync(join(binDir, "pi"), "utf8"), "existing Pi executable\n");
	const calls = commands();
	assert.deepEqual(calls.find((call) => call.command === "npm").args, [
		"ci",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
	]);
	const fetch = calls.find((call) => call.args.includes("fetch"));
	assert.deepEqual(fetch.args.slice(2), [
		"fetch",
		"--quiet",
		"--depth",
		"1",
		"https://github.com/yaoshining/codey.git",
		revision,
	]);
	assert.deepEqual(readdirSync(installDir), [revision]);
	const profile = join(zshDir, ".zshrc");
	assert.match(readFileSync(profile, "utf8"), /# Codey CLI path/);
	const zsh = spawnSync("zsh", ["-f", "-c", 'source "$1"; command -v codey; codey --version', "codey-test", profile], {
		cwd,
		env: environment,
		encoding: "utf8",
	});
	assert.ifError(zsh.error);
	assert.equal(zsh.status, 0, zsh.stderr);
	assert.equal(zsh.stdout, `${join(binDir, "codey")}\n1.6.0\n`);
});

test("reinstalling a verified revision does not fetch, reinstall or duplicate shell configuration", (t) => {
	const { run, commands, zshDir } = installFixture(t);
	const first = run();
	assert.equal(first.status, 0, first.stderr);
	const second = run();
	assert.equal(second.status, 0, second.stderr);
	assert.equal(commands().filter((call) => call.command === "npm").length, 1);
	assert.equal(commands().filter((call) => call.args.includes("fetch")).length, 1);
	const profile = readFileSync(join(zshDir, ".zshrc"), "utf8");
	assert.equal(profile.split("# Codey CLI path").length - 1, 1);
});

test("failed dependency installation preserves the prior working entry and removes staging files", (t) => {
	const { run, installDir, binDir, environment, cwd } = installFixture(t);
	const installed = run();
	assert.equal(installed.status, 0, installed.stderr);
	const previous = readlinkSync(join(binDir, "codey"));
	const nextRevision = "a".repeat(40);
	const failed = run(nextRevision, { CODEY_TEST_NPM_FAIL: "1" });
	assert.equal(failed.status, 43);
	assert.equal(readlinkSync(join(binDir, "codey")), previous);
	assert.equal(existsSync(join(installDir, nextRevision)), false);
	assert.deepEqual(readdirSync(installDir), [revision]);
	const version = spawnSync(join(binDir, "codey"), ["--version"], { cwd, env: environment, encoding: "utf8" });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout, "1.6.0\n");
});

test("installer refuses an unrelated command before fetching or running npm", (t) => {
	const { run, commands, binDir } = installFixture(t);
	const entry = join(binDir, "codey");
	writeFileSync(entry, "keep this command\n");
	const result = run();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Refusing to overwrite/);
	assert.equal(readFileSync(entry, "utf8"), "keep this command\n");
	assert.deepEqual(commands(), []);
});

test("installer preserves unrelated symlinks outside its root and under non-SHA directories", (t) => {
	for (const location of ["outside", "non-sha"]) {
		const { run, commands, directory, installDir, binDir } = installFixture(t);
		const target =
			location === "outside"
				? join(directory, revision, "codey/bin/codey")
				: join(installDir, "my-other-checkout", "codey/bin/codey");
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "unrelated executable\n");
		const entry = join(binDir, "codey");
		symlinkSync(target, entry);
		const result = run();
		assert.notEqual(result.status, 0, location);
		assert.match(result.stderr, /Refusing to replace an unrelated link/);
		assert.equal(readlinkSync(entry), target);
		assert.equal(readFileSync(target, "utf8"), "unrelated executable\n");
		assert.deepEqual(commands(), []);
	}
});

test("installer requires a full pinned revision", (t) => {
	const { run, commands } = installFixture(t);
	for (const invalid of ["main", "0123456", "A".repeat(40)]) {
		const result = run(invalid);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /full commit SHA/);
	}
	assert.deepEqual(commands(), []);
});

test("Bash installation updates its active login profile and interactive rc", (t) => {
	const { run, home, environment, cwd, binDir } = installFixture(t, "/bin/bash");
	writeFileSync(join(home, ".profile"), "# Existing profile\n");
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(home, ".bash_profile")), false);
	assert.equal(existsSync(join(home, ".bash_login")), false);
	for (const name of [".bashrc", ".profile"]) {
		const profile = join(home, name);
		assert.match(readFileSync(profile, "utf8"), /# Codey CLI path/);
		const bash = spawnSync(
			"bash",
			["--noprofile", "--norc", "-c", 'source "$1"; command -v codey; codey --version', "codey-test", profile],
			{
				cwd,
				env: environment,
				encoding: "utf8",
			},
		);
		assert.ifError(bash.error);
		assert.equal(bash.status, 0, bash.stderr);
		assert.equal(bash.stdout, `${join(binDir, "codey")}\n1.6.0\n`);
	}
});
