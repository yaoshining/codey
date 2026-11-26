// Use the Node and platform trust stores unless the user pinned a CA for this origin.
import { getCACertificates } from "node:tls";

export function bridgeTlsOptions(pem) {
	if (pem) return { ca: pem, rejectUnauthorized: true };
	return { ca: [...new Set([...getCACertificates("default"), ...getCACertificates("system")])], rejectUnauthorized: true };
}
