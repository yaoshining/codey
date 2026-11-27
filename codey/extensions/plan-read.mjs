// The Plan model can read regular UTF-8 files and list directories, using read-only descriptors.
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";

const limit = 24 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const protectedName = /^(?:\.|.*\.(?:pem|key|p12)$|(?:auth|credentials)(?:\.json)?$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/i;
const pathSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false };
export const planTools = [
	{ name: "plan_list", description: "List visible entries in a workspace-relative directory. Use . for the root.", parameters: pathSchema },
	{ name: "plan_read", description: "Read a small UTF-8 text file at a workspace-relative path.", parameters: pathSchema },
];

export class PlanDataLimit extends Error {}

function charge(budget, size) {
	if (size > budget.remaining) throw new PlanDataLimit();
	budget.remaining -= size;
}

export async function inspectPlanPath(root, name, args, budget) {
	if (!planTools.some((tool) => tool.name === name)) throw new Error("Tool unavailable in Plan mode.");
	const input = args?.path;
	if (typeof input !== "string" || input.length > 512 || Object.keys(args).length !== 1 || /[:\\\x00-\x1f\x7f]/.test(input)) {
		throw new Error("Use a workspace-relative path.");
	}
	let path = root;
	for (const part of name === "plan_list" && input === "." ? [] : input.split("/")) {
		if (!part || protectedName.test(part)) throw new Error("Path is unavailable in Plan mode.");
		path = join(path, part);
		if ((await lstat(path)).isSymbolicLink()) throw new Error("Plan mode does not follow symbolic links.");
	}
	if (await realpath(path) !== path) throw new Error("Path changed during Plan inspection.");
	if (name === "plan_list") {
		const directory = await opendir(path);
		const visible = [];
		let scanned = 0;
		function add(entry) {
			const bytes = Buffer.byteLength(entry) + (visible.length ? 1 : 0);
			if (bytes > budget.remaining) {
				budget.remaining = 0;
				return;
			}
			budget.remaining -= bytes;
			visible.push(entry);
		}
		for await (const entry of directory) {
			if (++scanned > 256 || visible.length >= 80) { add("… listing truncated"); break; }
			if (!protectedName.test(entry.name) && !/[\\\x00-\x1f\x7f]/.test(entry.name)) {
				if (entry.isDirectory()) add(`${entry.name}/`);
				else if (entry.isFile()) add(entry.name);
			}
			if (budget.remaining === 0) break;
		}
		if (await realpath(path) !== path) throw new Error("Path changed during Plan inspection.");
		if (visible.length === 0) add("No visible files.");
		if (visible.length === 0) throw new PlanDataLimit();
		return visible.join("\n");
	}
	const original = await lstat(path);
	if (!original.isFile() || original.nlink !== 1 || original.size > limit) throw new Error("Plan can read only small, regular text files.");
	if (original.size > budget.remaining) throw new PlanDataLimit();
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (stat.ino !== original.ino || stat.dev !== original.dev || stat.nlink !== 1 || await realpath(path) !== path) {
			throw new Error("Path changed during Plan inspection.");
		}
		if (stat.size > limit) throw new Error("Plan can read only small, regular text files.");
		if (stat.size > budget.remaining) throw new PlanDataLimit();
		const buffer = Buffer.alloc(stat.size);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		charge(budget, bytesRead);
		const bytes = buffer.subarray(0, bytesRead);
		if (bytes.includes(0)) throw new Error("Plan can read only small, regular text files.");
		return decoder.decode(bytes);
	} finally {
		await file.close();
	}
}
