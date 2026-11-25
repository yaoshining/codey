// Move the active Codey session into a managed checkout or browse this repository's worktrees.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { Text } from "@earendil-works/pi-tui";
import { getDefaultSessionDir, SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { copyToClipboard, readClipboardText } from "../../packages/coding-agent/src/utils/clipboard.ts";
import { styleInfo } from "../branding.mjs";
import { createCheckout, deleteManagedWorktree, listManagedWorktrees } from "../worktree.mjs";

const noticeEntry = "codey-worktree-cwd";
const continueChoice = "Continue current conversation";
const newChoice = "Start new conversation";
const browseChoice = "Browse worktrees";
const copyChoice = "Copy working directory";
const deleteChoice = "Delete worktree";

export default function worktree(pi) {
	pi.registerEntryRenderer(noticeEntry, (entry, _options, theme) => {
		if (typeof entry.data?.path !== "string") return;
		const line = `• Working directory changed to: ${displayPath(entry.data.path)}`;
		return new Text(styleInfo(line, theme), 1, 0);
	});

	pi.registerCommand("worktree", {
		description: "Start or browse managed Git worktrees",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Use /worktree in an interactive Codey terminal.", "info");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /worktree", "info");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for the current operation before switching worktrees.", "warning");
				return;
			}
			try {
				const choice = await ctx.ui.select("Worktrees", [continueChoice, newChoice, browseChoice]);
				if (choice === browseChoice) await browse(ctx);
				else if (choice === continueChoice || choice === newChoice) {
					requireStoredSession(ctx);
					const checkout = createCheckout({ task: `task-${randomBytes(6).toString("hex")}`, base: "HEAD" }, ctx.cwd);
					await switchCheckout(ctx, checkout.path, choice === continueChoice);
				}
			} catch (error) {
				ctx.ui.notify(stripVTControlCharacters(error.message), "error");
			}
		},
	});
}

function displayPath(path) {
	return stripVTControlCharacters(path).replace(/[\r\n\t]/g, " ");
}

function requireStoredSession(ctx) {
	if (!ctx.sessionManager.getSessionFile()) throw new Error("Worktree switching requires a saved-session Codey launch.");
}

async function switchCheckout(ctx, path, keepHistory) {
	requireStoredSession(ctx);
	const current = ctx.sessionManager;
	const currentDir = current.getSessionDir();
	const sessionDir = currentDir === getDefaultSessionDir(ctx.cwd) ? undefined : currentDir;
	const manager = SessionManager.create(path, sessionDir, keepHistory ? { parentSession: current.getSessionFile() } : undefined);
	const sessionFile = manager.getSessionFile();
	// Pi opens the session by its stored cwd. Serialize the active branch so an
	// inactive sibling branch cannot become the new leaf, and leave the source untouched.
	const entries = [manager.getHeader(), ...(keepHistory ? current.getBranch() : [])];
	writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
	SessionManager.open(sessionFile).appendCustomEntry(noticeEntry, { path });
	const result = await ctx.switchSession(sessionFile, {
		withSession: async (next) => {
			try {
				process.chdir(next.cwd);
			} catch (error) {
				next.ui.notify(`Could not update process directory: ${error.message}`, "error");
			}
		},
	});
	if (result.cancelled) ctx.ui.notify(`Switch cancelled. Worktree kept at ${displayPath(path)}.`, "info");
}

async function browse(ctx) {
	const entries = listManagedWorktrees(ctx.cwd);
	if (!entries.length) {
		ctx.ui.notify("No managed worktrees in this repository.", "info");
		return;
	}
	const byLabel = new Map(entries.map((entry) => [
		`${entry.id} · ${displayPath(entry.path)}${entry.current ? " (current)" : ""}`, entry,
	]));
	const label = await ctx.ui.select("Browse worktrees", [...byLabel.keys()]);
	const entry = byLabel.get(label);
	if (!entry) return;
	const title = `Worktree: ${displayPath(entry.path)}${entry.current ? "\nDelete worktree (unavailable in current checkout)" : ""}`;
	const choices = [newChoice, copyChoice, ...(entry.current ? [] : [deleteChoice])];
	const action = await ctx.ui.select(title, choices);
	if (action === newChoice) await switchCheckout(ctx, entry.path, false);
	else if (action === copyChoice) await copyPath(ctx, entry.path);
	else if (action === deleteChoice && await ctx.ui.confirm("Delete worktree?", displayPath(entry.path))) {
		const path = deleteManagedWorktree(entry.id, ctx.cwd);
		ctx.ui.notify(`Removed worktree at ${displayPath(path)}.`, "info");
	}
}

async function copyPath(ctx, path) {
	try {
		await copyToClipboard(path);
		// OSC 52 can be sent without a clipboard read succeeding. In that case
		// the terminal's acceptance is unknown, so don't claim a verified copy.
		if (await readClipboardText() !== path) throw new Error("Clipboard copy could not be confirmed.");
		ctx.ui.notify("Copied Worktree working directory to clipboard", "info");
	} catch (error) {
		ctx.ui.notify(`${error.message} Copy the path manually: ${displayPath(path)}`, "error");
	}
}
