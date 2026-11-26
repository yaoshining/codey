// Redirect only the fake public HTTPS destination to the controlled test service.
import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const request = https.request;
const hostname = "codey-approval.example";
Resolver.prototype.resolve4 = function (host) {
	assert.equal(host, hostname, "Only the local fixture's synthetic DNS name may be resolved");
	return Promise.resolve(["93.184.215.14"]);
};
https.request = function (url, options, callback) {
	assert.ok(url instanceof URL && url.hostname === hostname, "Only the local HTTPS fixture may be contacted");
	assert.equal(options.method, "GET");
	assert.equal(options.servername, hostname);
	assert.equal(options.rejectUnauthorized, true);
	options.lookup(hostname, {}, (error, address, family) => {
		assert.ifError(error);
		assert.equal(address, "93.184.215.14");
		assert.equal(family, 4);
	});
	return request.call(this, url, { ...options,
		port: Number(process.env.CODEY_FIXTURE_PORT), ca: readFileSync(process.env.CODEY_FIXTURE_CERT),
		lookup: (_host, opts, done) => opts.all
			? done(null, [{ address: "127.0.0.1", family: 4 }])
			: done(null, "127.0.0.1", 4),
	}, callback);
};
syncBuiltinESMExports();
