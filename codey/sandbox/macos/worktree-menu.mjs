// User-only management for the lightweight sandbox terminal.
import { execFileSync } from "node:child_process";
import { styleInfo } from "../../branding.mjs";
import { sandboxWorktrees } from "./worktree.mjs";

async function pick(input, signal, title, options) {
	console.log(`${title}\n${options.map((option, index) => `  ${index + 1}. ${option}`).join("\n")}`);
	const reply = (await input.question("Choose a number, or press Enter to cancel: ", { signal })).trim();
	if (/^[1-9][0-9]*$/.test(reply)) return options[Number(reply) - 1];
}

export async function worktreeMenu(input, root, home, cwd, signal) {
	const keep = "New worktree with a copy of this conversation";
	const fresh = "New worktree with an empty conversation";
	const browse = "Browse worktrees";
	const choice = await pick(input, signal, "Worktrees", [keep, fresh, browse]);
	if (!choice) return;
	const manager = sandboxWorktrees(root, home);
	function request(path, keepHistory) {
		return { path, keepHistory, verify() {
			if (!manager.list(cwd).some((item) => item.path === path && !item.current)) {
				throw new Error("The target worktree is no longer registered. The current session was kept.");
			}
		} };
	}
	if (choice === keep || choice === fresh) return request(manager.create(cwd), choice === keep);
	const entries = manager.list(cwd);
	if (!entries.length) return console.log("No managed worktrees in this repository.");
	const labels = entries.map(({ id, branch, path, current }) => `${id} · ${branch} · ${path}${current ? " (current)" : ""}`);
	const label = await pick(input, signal, browse, labels);
	if (!label) return;
	const entry = entries[labels.indexOf(label)];
	const copy = "Copy working directory";
	const remove = "Delete worktree";
	const carry = "Switch and copy this conversation";
	const actions = entry.current ? [copy] : [carry, "Switch with an empty conversation", copy, remove];
	const action = await pick(input, signal, `Worktree: ${entry.path}${entry.current ? "\nDelete worktree is unavailable in the current checkout." : ""}`, actions);
	if (action === copy) {
		const env = { PATH: "/usr/bin:/bin" };
		try {
			execFileSync("/usr/bin/pbcopy", [], { input: entry.path, env, cwd: "/", timeout: 2500, stdio: ["pipe", "pipe", "pipe"] });
			if (execFileSync("/usr/bin/pbpaste", [], { env, cwd: "/", encoding: "utf8", timeout: 2500 }) !== entry.path) throw new Error();
			console.log(styleInfo("Copied Worktree working directory to clipboard"));
		} catch { console.log(`Could not verify the clipboard copy. Copy the path manually: ${entry.path}`); }
	} else if (action === remove) {
		if (await pick(input, signal, `Delete ${entry.path}?`, ["Keep worktree", remove]) === remove) {
			console.log(styleInfo(`Removed worktree at ${manager.remove(entry.id, cwd)}.`));
		}
	} else if (action) {
		return request(entry.path, action === carry);
	}
}
