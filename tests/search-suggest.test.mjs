import assert from "node:assert/strict";
import { test } from "node:test";
import { DBS, guarded, NOW } from "./helpers/search-fixture.mjs";
import { loadTs } from "./helpers/sqlite.mjs";

// The search window's server side (workers/lib/search-suggest-sql.ts) on both
// schemas: completion, people, counts, what would match when nothing does,
// and saved searches.

const idx = await loadTs("workers/lib/mail-index-sql.ts");
const sg = await loadTs("workers/lib/search-suggest-sql.ts");

const ENGINES = ["d1", "index"];
const base = (engine, overrides = {}) => idx.emptyFilter({ view: "inbox", engine, ...overrides });
const suggest = (engine, text, at = -1, overrides = {}) => idx.runSync(sg.suggestQuery(base(engine, overrides), text, at, NOW), guarded(DBS[engine].exec));
const values = (list) => list.map((p) => `${p.value}:${p.count}`);

test("completes from:, to: and cc: from the mail", () => {
	for (const engine of ENGINES) {
		assert.deepEqual(values(suggest(engine, "invoice from:an", 15).completions), ["ann@example.org:2"], `${engine}: by address prefix`);
		assert.deepEqual(values(suggest(engine, "from:lee", 8).completions), ["ann@example.org:1"], `${engine}: by name`);
		const domains = values(suggest(engine, "from:exam", 9).completions);
		assert.equal(domains[0], "example.net:3", `${engine}: domains and addresses by conversations`);
		assert.ok(domains.includes("example.org:2") && domains.includes("ann@example.org:2"), engine);
		assert.deepEqual(values(suggest(engine, "to:ann", 6).completions), ["ann@example.org:1"], `${engine}: recipients`);
		assert.deepEqual(values(suggest(engine, "-cc:boss", 8).completions), ["boss@example.net:1"], `${engine}: cc: is a recipient`);
		assert.deepEqual(values(suggest(engine, "to:", 3).completions), ["ann@example.org:1"], `${engine}: empty to: lists who you wrote to`);
		assert.equal(suggest(engine, "from:an x", 9).completions, null, `${engine}: the cursor is on another word`);
		assert.equal(suggest(engine, "subject:an", 10).completions, null, `${engine}: other operators complete in the browser`);
	}
});

test("people with an empty box", () => {
	for (const engine of ENGINES) {
		const out = suggest(engine, "");
		assert.deepEqual(values(out.people), ["ann@example.org:2", "billing@example.net:1", "news@example.net:1"], engine);
		assert.equal(out.people[0].name.length > 0, true);
		assert.equal(out.count, null);
	}
});

test("counts and narrow", () => {
	for (const engine of ENGINES) {
		const out = suggest(engine, "invoice");
		assert.equal(out.count, 1, engine);
		assert.deepEqual(out.narrow.map((n) => `${n.token}:${n.count}`), ["from:example.org:1", "is:unread:1", "has:attachment:1"], engine);
		assert.deepEqual(suggest(engine, "invoice is:unread").narrow.map((n) => n.token), ["from:example.org", "has:attachment"], `${engine}: typed filters aren't offered`);
		assert.deepEqual(suggest(engine, "invoice", -1, { view: "anywhere" }).narrow.find((n) => n.token.startsWith("label:")), { token: "label:receipts", label: "Receipts", count: 1 }, engine);
		assert.equal(suggest(engine, "invoice").nothing, null);
	}
});

test("when nothing matches", () => {
	for (const engine of ENGINES) {
		let out = suggest(engine, "receipt");
		assert.equal(out.count, 0, engine);
		assert.deepEqual(out.nothing, { everywhere: 1, removals: [] }, `${engine}: it is in another folder`);

		out = suggest(engine, "lunch is:read");
		assert.deepEqual(out.nothing, { everywhere: null, removals: [{ text: "is:read", start: 6, end: 13, count: 1 }] }, `${engine}: a filter hides it`);

		out = suggest(engine, "in:trash lunch");
		assert.deepEqual(out.nothing, { everywhere: 1, removals: [{ text: "in:trash", start: 0, end: 8, count: 1 }] }, `${engine}: everywhere drops in:`);

		assert.deepEqual(suggest(engine, "zzzz").nothing, { everywhere: null, removals: [] });
	}
});

test("errors, requests and stores", () => {
	for (const engine of ENGINES) {
		const out = suggest(engine, "before:soon invoice");
		assert.deepEqual(out.errors, ["before: needs a date like 2026-01-31 or an age like 30d"], engine);
		assert.equal(out.count, 1, `${engine}: the bad value is left out`);
		assert.equal(suggest(engine, "find the invoice from ann").interpretable, true);
		assert.equal(suggest(engine, "invoice").interpretable, false);
	}
	const index = suggest("index", "cc:boss");
	assert.equal(index.count, null);
	assert.match(index.errors[0], /works once mail is stored in D1/);
	assert.equal(suggest("d1", "cc:boss", -1, { view: "anywhere" }).count, 1);
});

test("saved searches", () => {
	for (const engine of ENGINES) {
		const exec = DBS[engine].exec;
		const run = (q) => idx.runSync(q, exec);
		const a = run(sg.createSavedSearchQuery({ query: "  invoice   is:unread " }, `s1-${engine}`));
		assert.deepEqual(a, { id: `s1-${engine}`, name: "invoice is:unread", query: "invoice is:unread", position: 0 }, `${engine}: the name defaults to the text`);
		const b = run(sg.createSavedSearchQuery({ name: "Receipts", query: "label:receipts" }, `s2-${engine}`));
		assert.equal(b.position, 1);
		assert.throws(() => run(sg.createSavedSearchQuery({ query: "invoice is:unread" })), /already saved/);
		assert.throws(() => run(sg.createSavedSearchQuery({ query: "   " })), /needs search text/);
		assert.throws(() => run(sg.createSavedSearchQuery({ query: "x".repeat(501) })), /limited to 500/);

		const listed = run(sg.listSavedSearchesQuery({ engine, tzOffset: 0 }, NOW));
		assert.deepEqual(listed.map((s) => [s.name, s.count]), [["invoice is:unread", 1], ["Receipts", 1]], `${engine}: counts over All mail`);
		assert.equal(run(sg.listSavedSearchesQuery()).every((s) => s.count === undefined), true, "no counts unless asked");

		assert.deepEqual(run(sg.updateSavedSearchQuery(b.id, { name: "Paid", position: 0 })), { id: b.id, name: "Paid", query: "label:receipts", position: 0 });
		assert.equal(run(sg.updateSavedSearchQuery("nope", { name: "x" })), null);
		assert.throws(() => run(sg.updateSavedSearchQuery(b.id, { query: "invoice is:unread" })), /already saved/);
		assert.deepEqual(run(sg.listSavedSearchesQuery()).map((s) => s.name), ["Paid", "invoice is:unread"], "ordered by position");

		run(sg.createSavedSearchQuery({ query: "cc:boss" }, `s3-${engine}`));
		const cc = run(sg.listSavedSearchesQuery({ engine, tzOffset: 0 }, NOW)).find((s) => s.query === "cc:boss");
		assert.equal(cc.count, engine === "d1" ? 1 : null, `${engine}: a search the store can't run has no count`);

		for (const s of run(sg.listSavedSearchesQuery())) assert.equal(run(sg.deleteSavedSearchQuery(s.id)), true);
		assert.equal(run(sg.deleteSavedSearchQuery("nope")), false);
		assert.deepEqual(run(sg.listSavedSearchesQuery()), []);
	}
});

test("a create or update error comes back as a value", async () => {
	assert.deepEqual(await sg.savedResult(() => { throw new sg.SavedSearchError("nope"); }), { error: "nope" });
	await assert.rejects(sg.savedResult(() => { throw new Error("boom"); }), /boom/);
});
