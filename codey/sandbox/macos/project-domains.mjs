// User-managed exact host grants stored outside the selected workspace.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contains } from "./seatbelt.mjs";

export function publicHostname(host) {
	return typeof host === "string" && host.length <= 253 &&
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host) &&
		!/\.(?:localhost|local|internal|home\.arpa|onion)$/.test(host);
}

export function projectDomains(home, workspace) {
	const key = createHash("sha256").update(workspace).digest("hex");
	const codey = join(home, ".codey");
	const agent = join(codey, "agent");
	const policy = join(agent, "sandbox-network-domains");
	const project = join(policy, key);
	if (contains(workspace, project)) throw new Error("The workspace must exclude the host Codey configuration.");

	function directory(create = false) {
		for (const path of [codey, agent, policy, project]) {
			if (create) {
				try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
			}
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (!stat) return false;
			if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
				throw new Error("The host Codey domain policy must use user-owned directories without group or public write access.");
			}
		}
		return true;
	}
	function granted(host) {
		const stat = lstatSync(join(project, host), { throwIfNoEntry: false });
		return stat?.isFile() && stat.uid === process.getuid() && stat.size === 0 && !(stat.mode & 0o022);
	}
	return {
		has: (host) => publicHostname(host) && directory() && granted(host),
		list: () => directory() ? readdirSync(project).filter((host) => publicHostname(host) && granted(host)).sort() : [],
		change(action, name) {
			const host = name.toLowerCase();
			if (!publicHostname(host)) throw new Error("Specify one exact public DNS hostname without a scheme, port, path, or wildcard.");
			if (action === "add") {
				directory(true);
				try {
					writeFileSync(join(project, host), "", { flag: "wx", mode: 0o600 });
				} catch (error) {
					if (error.code !== "EEXIST" || !granted(host)) throw error;
				}
			} else if (directory()) {
				try { unlinkSync(join(project, host)); } catch (error) { if (error.code !== "ENOENT") throw error; }
			}
			return host;
		},
	};
}
