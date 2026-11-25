// Add Codey's extension to Pi's source entry without changing Pi's launcher.
import { setupCli } from "../packages/coding-agent/src/cli/setup.ts";
import { main } from "../packages/coding-agent/src/main.ts";
import { branding } from "./branding.mjs";
import review from "./extensions/review.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--codey-version") {
	console.log(branding.version);
} else {
	setupCli();
	await main(args, {
		branding,
		extensionFactories: [{ name: "codey-review", factory: review, builtin: true, replaceable: true }],
	});
}
