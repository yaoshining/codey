// Add Codey's extension to Pi's source entry without changing Pi's launcher.
import { setupCli } from "../packages/coding-agent/src/cli/setup.ts";
import { main } from "../packages/coding-agent/src/main.ts";
import review from "./extensions/review.mjs";

setupCli();
await main(process.argv.slice(2), {
	extensionFactories: [{ name: "codey-review", factory: review, builtin: true, replaceable: true }],
});
