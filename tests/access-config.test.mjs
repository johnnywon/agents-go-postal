import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { accessConfigured, ACCESS_PLACEHOLDERS } = await loadTs("workers/lib/access-config.ts");

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

test("the placeholders match .dev.vars.example, which the button copies", async () => {
	const { readFileSync } = await import("node:fs");
	const example = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
	assert.match(example, new RegExp(`^POLICY_AUD=${ACCESS_PLACEHOLDERS.POLICY_AUD}$`, "m"));
	assert.match(example, new RegExp(`^TEAM_DOMAIN=https://${ACCESS_PLACEHOLDERS.TEAM_DOMAIN.replace(/\./g, "\\.")}$`, "m"));
});
