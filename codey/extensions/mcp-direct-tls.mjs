// Probe the selected origin with TLS only, and bind subsequent TLS to the approved leaf.
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity, connect } from "node:tls";

const chainErrors = new Set([
	"DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

function hostname(url) {
	return url.hostname.replace(/^\[|\]$/g, "");
}

function verifySan(cert, host) {
	if (!(isIP(host) ? cert.checkIP(host) : cert.checkHost(host, { subject: "never" }))) {
		throw new Error("The certificate SAN must match the endpoint hostname or IP address.");
	}
}

function verifyLeaf(cert, host) {
	if (!cert || cert.subject !== cert.issuer || !cert.verify(cert.publicKey)) {
		throw new Error("The service leaf is not self-signed. Verify its issuing CA and use the manual MCP CA configuration.");
	}
	if (Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo)) {
		throw new Error("The service certificate is expired or not yet valid.");
	}
	verifySan(cert, host);
}

export function defaultDirectTls() {
	return {
		rejectUnauthorized: true,
		checkServerIdentity(host, peer) {
			try {
				verifySan(new X509Certificate(peer.raw), host);
				return checkServerIdentity(host, peer);
			} catch (error) { return error; }
		},
	};
}

export function pinnedTls(url, pem) {
	const expected = new X509Certificate(pem);
	const host = hostname(url);
	return {
		ca: pem, rejectUnauthorized: true,
		checkServerIdentity(_name, peer) {
			try {
				const actual = new X509Certificate(peer.raw);
				verifyLeaf(actual, host);
				if (!actual.raw.equals(expected.raw)) {
					throw Object.assign(new Error("The MCP service certificate changed."), { code: "CODEY_MCP_LEAF_CHANGED" });
				}
				return checkServerIdentity(host, peer);
			} catch (error) { return error; }
		},
	};
}

export function directTlsError(error, pinned) {
	for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
		if (pinned && (chainErrors.has(cause.code) || cause.code === "CODEY_MCP_LEAF_CHANGED")) {
			return new Error("The saved MCP certificate no longer verifies. Recheck the certificate and its fingerprint before replacing the saved service.", { cause: error });
		}
		if (["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"].includes(cause.code)) {
			return new Error("The MCP certificate is expired or not yet valid.", { cause: error });
		}
	}
	return error;
}

function handshake(url, options) {
	const host = hostname(url);
	return new Promise((resolve, reject) => {
		// No bytes are written to this TLS socket. It is closed before any HTTP request can run.
		const socket = connect({ host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host, ...options });
		const timeout = setTimeout(() => socket.destroy(new Error("TLS handshake timed out.")), 8_000);
		socket.once("error", reject);
		socket.once("close", () => {
			clearTimeout(timeout);
			reject(new Error("The TLS connection closed during the handshake."));
		});
		socket.once("secureConnect", () => {
			resolve(socket.getPeerX509Certificate());
			socket.destroy();
		});
	});
}

export async function discoverCertificate(url) {
	try {
		await handshake(url, defaultDirectTls());
		return;
	} catch (error) {
		if (["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"].includes(error.code)) {
			throw new Error("The service certificate is expired or not yet valid.");
		}
		if (!chainErrors.has(error.code)) throw error;
	}
	const cert = await handshake(url, { rejectUnauthorized: false });
	verifyLeaf(cert, hostname(url));
	return { pem: cert.toString(), fingerprint: cert.fingerprint256 };
}

export async function confirmCertificate(url, pem) {
	try {
		const cert = await handshake(url, pinnedTls(url, pem));
		if (!cert?.raw.equals(new X509Certificate(pem).raw)) throw new Error("Certificate changed.");
	} catch {
		throw new Error("Could not revalidate the confirmed certificate. Recheck the service and its fingerprint before adding it.");
	}
}
