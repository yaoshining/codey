// Change only the synthetic LAN names. The CLI still makes real TCP/HTTP requests.
import dns from "node:dns";
import { appendFileSync, readFileSync } from "node:fs";

const lookup = dns.promises.lookup;
dns.promises.lookup = async (hostname, options) => {
	if (hostname !== "nas.local") return lookup.call(dns.promises, hostname, options);
	if (!options.all) throw new Error("Expected the full synthetic DNS answer.");
	appendFileSync(process.env.CODEY_TEST_DNS_LOG, `${hostname}\n`);
	return JSON.parse(readFileSync(process.env.CODEY_TEST_DNS_ANSWERS, "utf8"));
};
