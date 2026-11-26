// One approved HTTPS GET through the host, with no shell, proxy, or workspace file access.
import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { Type } from "typebox";

const maxBytes = 256 * 1024;

function destination(value) {
	if (typeof value !== "string" || value.length > 2048 || !/^https:\/\//i.test(value) || /[^\x21-\x7e]|[\\?#]/.test(value)) {
		throw new Error("Use one HTTPS URL without a query or fragment.");
	}
	const url = new URL(value);
	const host = url.hostname;
	if (url.protocol !== "https:" || url.port || url.username || url.password || isIP(host) ||
		!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host) ||
		/\.(?:localhost|local|internal|home\.arpa|onion)$/.test(host)) {
		throw new Error("Use a public DNS hostname on HTTPS port 443, without credentials.");
	}
	return url;
}

function publicIPv4(address) {
	if (isIP(address) !== 4) return false;
	const [a, b, c] = address.split(".").map(Number);
	return a > 0 && a < 224 && a !== 10 && a !== 127 &&
		!(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
		!(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) &&
		!(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
}

async function read(url, signal) {
	const resolver = new Resolver();
	const cancel = () => resolver.cancel();
	signal.throwIfAborted();
	signal.addEventListener("abort", cancel, { once: true });
	let addresses;
	try {
		addresses = await resolver.resolve4(url.hostname);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
	signal.throwIfAborted();
	if (!addresses.length || !addresses.every(publicIPv4)) throw new Error("The HTTPS destination must resolve only to public IPv4 addresses.");
	const address = addresses[0];
	return await new Promise((resolve, reject) => {
		const req = request(url, {
			method: "GET", family: 4, agent: false, signal, rejectUnauthorized: true, servername: url.hostname,
			lookup: (_host, options, callback) => options.all
				? callback(null, [{ address, family: 4 }])
				: callback(null, address, 4),
		}, (res) => {
			res.on("error", reject);
			const type = res.headers["content-type"] ?? "";
			if (res.statusCode !== 200 || !/^(?:text\/|application\/(?:json|xml)(?:[\s;]|$))/i.test(type)) {
				reject(new Error(`HTTPS read refused HTTP ${res.statusCode} or an unsupported content type. Redirects are not followed.`));
				res.destroy();
				return;
			}
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.length;
				if (size > maxBytes) {
					reject(new Error("HTTPS response exceeds 256 KiB."));
					res.destroy();
				} else chunks.push(chunk);
			});
			res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		});
		req.on("error", reject);
		req.end();
	});
}

export function httpsReadTool(approve) {
	return {
		name: "https_read",
		label: "HTTPS read",
		description: "Read one public HTTPS URL as text after the terminal user approves this call. No shell, credentials, query, redirects, or file upload. Never retry a denied request.",
		parameters: Type.Object({ url: Type.String() }),
		execute: async (_id, { url: raw }, signal) => {
			try {
				const url = destination(raw);
				if (signal?.aborted || !await approve(url.href, signal)) throw new Error("HTTPS read was not approved. No request was made.");
				const timeout = AbortSignal.timeout(15_000);
				const body = await read(url, signal ? AbortSignal.any([signal, timeout]) : timeout);
				return { content: [{ type: "text", text: body }], details: undefined };
			} catch (error) {
				return { content: [{ type: "text", text: error.message }], details: undefined, isError: true };
			}
		},
	};
}
