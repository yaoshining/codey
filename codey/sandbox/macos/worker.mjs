// Runs only after the parent has started /usr/bin/sandbox-exec.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSkills, loadSkill } from "./acp-skills.mjs";
import { collectSandboxReview } from "./review-git.mjs";
import { toolDefinitions } from "./tools.mjs";

try {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > 1024 * 1024) throw new Error("Tool request exceeds 1 MiB.");
		chunks.push(chunk);
	}
	const { name, args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (name === "ready") {
		readdirSync(process.cwd());
		writeFileSync(join(process.env.TMPDIR, "worker-probe"), "sandbox probe");
		let denied = false;
		try {
			readFileSync(args.hostProbe, "utf8");
		} catch (error) {
			denied = error.code === "EACCES" || error.code === "EPERM";
		}
		if (!denied) throw new Error("Seatbelt did not deny access to the host preflight file.");
		console.log(JSON.stringify({ ready: true }));
	} else if (name === "review") {
		console.log(JSON.stringify({ patches: collectSandboxReview(process.cwd(), args.git, process.env.TMPDIR) }));
	} else if (name === "acp-skills") {
		console.log(JSON.stringify(discoverSkills(process.cwd(), "project")));
	} else if (name === "acp-skill") {
		console.log(JSON.stringify(loadSkill(process.cwd(), "project", args.name)));
	} else {
		const tool = toolDefinitions(process.cwd()).find((definition) => definition.name === name);
		if (!tool) throw new Error("Tool unavailable in the macOS sandbox.");
		const result = await tool.execute("sandbox", args);
		console.log(JSON.stringify({
			content: result.content.filter(({ type }) => type === "text"),
			exitCode: result.structuredContent?.exit_code,
			isError: result.isError === true,
		}));
	}
} catch (error) {
	console.log(JSON.stringify({ error: String(error.message).slice(0, 96 * 1024) }));
}
