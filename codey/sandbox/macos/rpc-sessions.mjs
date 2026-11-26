// Keep native RPC conversations in a host-owned directory scoped to one workspace.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { lockSync } from "proper-lockfile";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.ts";
import { contains } from "./seatbelt.mjs";

const sessionName = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_([0-9a-f-]{36})\.jsonl$/;
const maxSessionSize = 16 * 1024 * 1024;

export function sandboxRpcSessions(home, workspace, ephemeral) {
	if (ephemeral) return (path) => {
		if (path !== undefined) throw new Error("Ephemeral sandbox sessions cannot be reopened.");
		return { manager: SessionManager.inMemory(workspace), release() {} };
	};
	const codey = join(home, ".codey");
	const agent = join(codey, "agent");
	const store = join(agent, "sandbox-rpc");
	const directory = join(store, createHash("sha256").update(workspace).digest("hex"));
	if (contains(workspace, store) || contains(store, workspace)) throw new Error("Choose a workspace outside the sandbox session store.");
	// Pi creates its JSONL file lazily, on the first conversation entry.
	process.umask(0o077);
	return (path) => {
		let match;
		if (path !== undefined) {
			match = sessionName.exec(basename(path));
			if (!isAbsolute(path) || dirname(path) !== directory || !match) {
				throw new Error("Only a Codey sandbox RPC session from this workspace can be reopened.");
			}
		}
		for (const part of [codey, agent, store, directory]) {
			try { mkdirSync(part, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
			const stat = lstatSync(part);
			const forbidden = part === store || part === directory ? 0o077 : 0o022;
			if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & forbidden)) {
				throw new Error("Sandbox RPC session storage needs private, user-owned directories.");
			}
		}
		const fresh = path === undefined ? SessionManager.create(workspace, directory) : undefined;
		const target = path ?? fresh.getSessionFile();
		const release = lockSync(target, { realpath: false });
		try {
			if (fresh) return { manager: fresh, release };
			const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > maxSessionSize) {
					throw new Error("The sandbox session file is not a private, bounded regular file.");
				}
				const buffer = Buffer.alloc(4096);
				const bytes = readSync(fd, buffer);
				const line = buffer.subarray(0, bytes).indexOf(10);
				const header = line > 0 && JSON.parse(buffer.subarray(0, line).toString("utf8"));
				if (header?.type !== "session" || header.cwd !== workspace || header.id !== match[1]) {
					throw new Error("The sandbox session does not match this workspace.");
				}
			} finally {
				closeSync(fd);
			}
			return { manager: SessionManager.open(target, directory, workspace), release };
		} catch (error) {
			release();
			throw error;
		}
	};
}
