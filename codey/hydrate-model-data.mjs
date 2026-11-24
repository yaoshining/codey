// Restore the ignored model metadata needed by Pi's source runtime.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateGeneratedModelData } from "../packages/ai/scripts/model-data.ts";
import { configureHttpDispatcher } from "../packages/coding-agent/src/core/http-dispatcher.ts";

/** Restore and validate a checkout's model metadata from its pinned npm archive. */
export async function hydrateModelData(root) {
	const pin = JSON.parse(readFileSync(join(root, "codey/model-data.json"), "utf8"));
	const packageRoot = join(root, "packages/ai");
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	if (manifest.version !== pin.version) {
		throw new Error("Codey model metadata pin must match the checkout's pi-ai version.");
	}
	// The pin is repository input; permit only the declared package on npm's registry.
	if (pin.url !== `https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${pin.version}.tgz`) {
		throw new Error("Codey model metadata must use the official pi-ai npm archive.");
	}
	// Use Pi's proxy-aware dispatcher, including its matching fetch implementation.
	configureHttpDispatcher();
	const response = await fetch(pin.url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`Model metadata download failed: HTTP ${response.status}`);
	const archive = Buffer.from(await response.arrayBuffer());
	const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
	if (integrity !== pin.integrity) throw new Error("Model metadata archive integrity does not match the Codey pin.");

	const staging = mkdtempSync(join(packageRoot, "src/providers/.model-generation-codey-"));
	try {
		const archivePath = join(staging, "pi-ai.tgz");
		writeFileSync(archivePath, archive);
		// Extract only metadata after verifying the archive; no package scripts or code run.
		execFileSync("tar", ["-xzf", archivePath, "-C", staging, "package/dist/providers/data"]);
		const target = join(packageRoot, "src/providers/data");
		const previous = join(staging, "previous");
		const hadPrevious = existsSync(target);
		if (hadPrevious) renameSync(target, previous);
		try {
			renameSync(join(staging, "package/dist/providers/data"), target);
			validateGeneratedModelData(packageRoot);
		} catch (error) {
			rmSync(target, { recursive: true, force: true });
			if (hadPrevious) renameSync(previous, target);
			throw error;
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	console.log(`Prepared Pi model metadata ${pin.version} from its verified npm archive.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await hydrateModelData(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
