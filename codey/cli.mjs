// Add Codey's extension to Pi's source entry without changing Pi's launcher.
import { setupCli } from "../packages/coding-agent/src/cli/setup.ts";
import { VERSION } from "../packages/coding-agent/src/config.ts";
import { main } from "../packages/coding-agent/src/main.ts";
import { branding } from "./branding.mjs";
import askUser from "./extensions/ask-user.mjs";
import { codeyMcp } from "./extensions/mcp-ca.mjs";
import plan from "./extensions/plan.mjs";
import customProviders from "./extensions/provider-ui.mjs";
import review from "./extensions/review.mjs";
import worktree from "./extensions/worktree.mjs";
import { runWorktree } from "./worktree.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--pi-version") {
	console.log(VERSION);
} else if (args.length === 1 && args[0] === "--codey-version") {
	console.log(branding.version);
} else if (args[0] === "worktree") {
	await runWorktree(args.slice(1), () => launch([]));
} else {
	await launch(args);
}

async function launch(args) {
	setupCli();
	await main(args, {
		branding,
		extensionFactories: [
			{ name: "codey-ask-user", factory: askUser, builtin: true },
			{ name: "codey-plan", factory: plan, builtin: true },
			{ name: "mcp", factory: codeyMcp, builtin: true, replaceable: true },
			{ name: "codey-provider", factory: customProviders, builtin: true, replaceable: true },
			{ name: "codey-review", factory: review, builtin: true, replaceable: true },
			{ name: "codey-worktree", factory: worktree, builtin: true, replaceable: true },
		],
	});
}
