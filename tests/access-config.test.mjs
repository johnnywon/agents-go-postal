import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { accessConfigured, accessConfigError, accessJwks, getAccessUrls, ACCESS_PLACEHOLDERS } = await loadTs("workers/lib/access-config.ts");

test("Access counts as set up only with both secrets present", () => {
	assert.equal(accessConfigured({ POLICY_AUD: "4714c1358e6a", TEAM_DOMAIN: "https://acme.cloudflareaccess.com" }), true);
	assert.equal(accessConfigured({ POLICY_AUD: "4714c1358e6a" }), false);
	assert.equal(accessConfigured({ TEAM_DOMAIN: "https://acme.cloudflareaccess.com" }), false);
	assert.equal(accessConfigured({ POLICY_AUD: "  ", TEAM_DOMAIN: "https://acme.cloudflareaccess.com" }), false);
});

test("the deploy button's placeholder secrets count as not set up", () => {
	const real = { POLICY_AUD: "4714c1358e6a", TEAM_DOMAIN: "https://acme.cloudflareaccess.com" };
	assert.equal(accessConfigured({ ...real, POLICY_AUD: ACCESS_PLACEHOLDERS.POLICY_AUD }), false);
	assert.equal(accessConfigured({ ...real, TEAM_DOMAIN: "https://your-team.cloudflareaccess.com" }), false);
	assert.equal(accessConfigured({ ...real, TEAM_DOMAIN: "https://your-team.cloudflareaccess.com/cdn-cgi/access/certs" }), false);
});

test("configuration errors identify missing and placeholder secrets", () => {
	assert.equal(accessConfigError({}), "POLICY_AUD is missing");
	assert.equal(accessConfigError({ POLICY_AUD: "aud" }), "TEAM_DOMAIN is missing");
	assert.match(accessConfigError({ POLICY_AUD: ACCESS_PLACEHOLDERS.POLICY_AUD, TEAM_DOMAIN: "https://acme.cloudflareaccess.com" }), /POLICY_AUD.*placeholder/);
	assert.match(accessConfigError({ POLICY_AUD: "aud", TEAM_DOMAIN: "https://your-team.cloudflareaccess.com" }), /TEAM_DOMAIN.*placeholder/);
});

test("TEAM_DOMAIN must be an HTTPS URL with a hostname", () => {
	const env = { POLICY_AUD: "aud" };
	assert.match(accessConfigError({ ...env, TEAM_DOMAIN: "acme.cloudflareaccess.com" }), /https:\/\//);
	assert.match(accessConfigError({ ...env, TEAM_DOMAIN: "http://acme.cloudflareaccess.com" }), /https:\/\//);
	assert.match(accessConfigError({ ...env, TEAM_DOMAIN: "https://" }), /hostname/);
	assert.equal(accessConfigError({ ...env, TEAM_DOMAIN: "https://acme.cloudflareaccess.com" }), null);
});

test("getAccessUrls handles the team URL and full certs URL", () => {
	assert.deepEqual(getAccessUrls("https://acme.cloudflareaccess.com"), {
		issuer: "https://acme.cloudflareaccess.com",
		certsUrl: new URL("https://acme.cloudflareaccess.com/cdn-cgi/access/certs"),
	});
	assert.deepEqual(getAccessUrls("https://acme.cloudflareaccess.com/cdn-cgi/access/certs"), {
		issuer: "https://acme.cloudflareaccess.com",
		certsUrl: new URL("https://acme.cloudflareaccess.com/cdn-cgi/access/certs"),
	});
});

test("Access JWKS instances are cached by certs URL", () => {
	const firstUrl = new URL("https://acme.cloudflareaccess.com/cdn-cgi/access/certs");
	assert.equal(accessJwks(firstUrl), accessJwks(new URL(firstUrl)));
	assert.notEqual(accessJwks(firstUrl), accessJwks(new URL("https://other.cloudflareaccess.com/cdn-cgi/access/certs")));
});

test("the placeholders match .dev.vars.example, which the button copies", async () => {
	const { readFileSync } = await import("node:fs");
	const example = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
	assert.match(example, new RegExp(`^POLICY_AUD=${ACCESS_PLACEHOLDERS.POLICY_AUD}$`, "m"));
	assert.match(example, new RegExp(`^TEAM_DOMAIN=https://${ACCESS_PLACEHOLDERS.TEAM_DOMAIN.replace(/\./g, "\\.")}$`, "m"));
});
