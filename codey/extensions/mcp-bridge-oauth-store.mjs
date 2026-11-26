// Keep bridge grants separate from direct MCP logins and bind them to the endpoint and CA.
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

export function oauthStatePath(bridge) {
	const id = createHash("sha256").update(JSON.stringify([bridge.name, bridge.url, bridge.pem])).digest("hex");
	return join(dirname(bridge.source), `.oauth-${id}.json`);
}

export function bridgeOAuthStore(path) {
	const folder = dirname(path);
	const privateOwner = (stat) => stat.uid === process.getuid() && !(stat.mode & 0o077);
	function secureFolder() {
		const stat = lstatSync(folder);
		if (!stat.isDirectory() || !privateOwner(stat)) throw new Error("MCP bridge OAuth needs a private settings directory (mode 0700).");
	}
	return {
		load() {
			secureFolder();
			let fd;
			try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
			catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile() || !privateOwner(stat) || stat.size > 128 * 1024) throw new Error("Invalid private MCP bridge OAuth credential file.");
				return JSON.parse(readFileSync(fd, "utf8"));
			} finally { closeSync(fd); }
		},
		save(value) {
			secureFolder();
			const data = JSON.stringify(value);
			if (Buffer.byteLength(data) > 128 * 1024) throw new Error("MCP bridge OAuth grant is too large.");
			const temp = mkdtempSync(join(folder, ".oauth-write-"));
			try {
				const file = join(temp, "grant");
				writeFileSync(file, data, { flag: "wx", mode: 0o600 });
				renameSync(file, path);
			} finally { rmSync(temp, { recursive: true, force: true }); }
		},
		remove() {
			secureFolder();
			try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
		},
		async locked(callback) {
			secureFolder();
			const release = await lockfile.lock(path, { realpath: false, retries: { retries: 20, minTimeout: 150, maxTimeout: 250 } });
			try { return await callback(); } finally { await release(); }
		},
	};
}
