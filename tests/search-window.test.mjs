import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

// The search window's logic (app/components/postal/search-window.ts):
// completion at the cursor, recent searches, plain-words requests and keys.

const w = await loadTs("app/components/postal/search-window.ts");

const DATA = {
	addresses: ["billing@example.com", "ann@example.org"],
	senders: [
		{ value: "store.example.com", count: 42 },
		{ value: "receipts@store.example.com", name: "Store", count: 30 },
		{ value: "ann@example.net", name: "Ann Lee", count: 3 },
	],
	recipients: [{ value: "lee@example.net", count: 5 }, { value: "ANN@example.org", count: 2 }],
	labels: [{ name: "Receipts", count: 31 }, { name: "Tax 2026", count: 4 }],
	now: new Date(2026, 9, 11, 15, 0),
};

const complete = (text, cursor = text.length) => {
	const ctx = w.completionAt(text, cursor);
	return ctx ? w.completions(ctx, DATA).map((c) => c.insert) : null;
};

test("what the cursor completes", () => {
	assert.equal(w.completionAt("invoice", 7), null, "a word");
	assert.equal(w.completionAt("from:ann ", 9), null, "after a space");
	assert.equal(w.completionAt("ratio:4:3", 9), null, "an unknown operator with a value");
	assert.deepEqual(w.completionAt("a from:St b", 9), { kind: "value", op: "from", partial: "st", start: 2, end: 9, negate: false, term: "from:St" });
	assert.deepEqual(w.completionAt("-label:", 7), { kind: "value", op: "label", partial: "", start: 0, end: 7, negate: true, term: "-label:" });
	assert.deepEqual(w.completionAt(`subject:"renewal no`, 19), { kind: "value", op: "subject", partial: "renewal no", start: 0, end: 19, negate: false, term: `subject:"renewal no` }, "inside a quote");
	assert.equal(w.completionAt("xyz:", 4).kind, "operator");
});

test("completions for each operator", () => {
	assert.deepEqual(complete("from:st"), ["from:store.example.com", "from:receipts@store.example.com"], "prefix of the value or after @ and dots, most mail first");
	assert.deepEqual(complete("from:ann"), ["from:ann@example.net"], "by name too");
	assert.deepEqual(complete("-from:store"), ["-from:store.example.com", "-from:receipts@store.example.com"], "keeps the dash");
	assert.deepEqual(complete("to:"), ["to:billing@example.com", "to:ann@example.org", "to:lee@example.net"], "your addresses, then recipients");
	assert.deepEqual(complete("cc:ann"), ["cc:ann@example.org"], "a recipient already listed as yours appears once");
	assert.deepEqual(complete("-cc:lee"), ["-cc:lee@example.net"]);
	assert.deepEqual(complete("label:t"), [`label:"Tax 2026"`], "names with spaces are quoted");
	assert.deepEqual(complete("in:s"), ["in:starred", "in:sent", "in:spam"]);
	assert.deepEqual(complete("is:"), ["is:unread", "is:read", "is:starred", "is:scheduled", "is:replied"]);
	assert.ok(complete("has:").includes("has:link"));
	assert.deepEqual(complete("sort:"), ["sort:relevance", "sort:date"]);
	assert.deepEqual(complete("is:starred"), [], "a finished value isn't offered again");
	assert.deepEqual(complete("-IS:read"), [], "nor with a dash or in another case");
	assert.deepEqual(complete("after:"), ["after:2026-10-11", "after:2026-10-10", "after:7d", "after:2026-10-01", "after:2026-09-01"]);
	assert.deepEqual(complete("before:yes"), ["before:2026-10-10"], "by label");
	assert.deepEqual(complete("subject:x"), [], "free text has nothing to complete");
	assert.equal(complete("foo:").length, 17, "every operator");
});

test("applying a completion", () => {
	const at = (text, cursor, insert) => w.applyCompletion(text, w.completionAt(text, cursor), insert);
	assert.deepEqual(at("invoice from:st", 15, "from:store.example.com"), { text: "invoice from:store.example.com ", cursor: 31 });
	assert.deepEqual(at("from:st invoice", 7, "from:store.example.com"), { text: "from:store.example.com invoice", cursor: 23 }, "mid-text keeps one space");
	assert.deepEqual(at("x:", 2, "label:"), { text: "label:", cursor: 6 }, "an operator leaves the cursor for its value");
	assert.equal(w.appendTerm("invoice ", "is:unread"), "invoice is:unread ");
	assert.equal(w.removeRange("a is:unread b", 2, 11), "a b");
	assert.deepEqual(w.filterTerms("invoice is:unread -label:x"), [{ text: "is:unread", start: 8, end: 17 }, { text: "-label:x", start: 18, end: 26 }]);
});

test("recent searches", () => {
	let list = [];
	for (const q of ["a", "b", " a  ", "c"]) list = w.addRecent(list, q);
	assert.deepEqual(list, ["c", "a", "b"], "newest first, no repeats, spaces tidied");
	for (let i = 0; i < 20; i++) list = w.addRecent(list, `q${i}`);
	assert.equal(list.length, w.MAX_RECENT);

	const store = new Map();
	const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
	w.saveRecent(storage, ["x", "y"]);
	assert.deepEqual(w.loadRecent(storage), ["x", "y"]);
	store.set(w.RECENT_KEY, "{not json");
	assert.deepEqual(w.loadRecent(storage), []);
	store.set(w.RECENT_KEY, JSON.stringify([1, "ok", null]));
	assert.deepEqual(w.loadRecent(storage), ["ok"]);
	const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
	assert.deepEqual(w.loadRecent(blocked), []);
	assert.doesNotThrow(() => w.saveRecent(blocked, ["x"]));
	assert.deepEqual(w.loadRecent(undefined), []);
});

test("plain-words requests", () => {
	assert.equal(w.looksLikeRequest("receipts from stripe last month"), true);
	assert.equal(w.looksLikeRequest("find the lease"), true);
	assert.equal(w.looksLikeRequest("quarterly report"), false);
	assert.equal(w.looksLikeRequest("find"), false);
	assert.equal(w.looksLikeRequest("receipts from stripe is:unread"), false, "operators mean it's a search");
	assert.equal(w.looksLikeRequest(`find "the lease"`), false);
});

test("keys", () => {
	const s = (o = {}) => ({ open: true, active: -1, rows: 3, completing: false, hasText: true, ...o });
	const k = (key, state, mods = {}) => w.windowKey({ key, ...mods }, state);

	assert.deepEqual(k("ArrowDown", s()), { type: "highlight", active: 0 });
	assert.deepEqual(k("ArrowDown", s({ active: 2 })), { type: "highlight", active: -1 }, "past the last row: none");
	assert.deepEqual(k("ArrowUp", s()), { type: "highlight", active: 2 }, "up from none: the last row");
	assert.deepEqual(k("ArrowUp", s({ active: 0 })), { type: "highlight", active: -1 });
	assert.equal(k("ArrowDown", s({ rows: 0 })), null);
	assert.deepEqual(k("ArrowDown", s({ open: false })), { type: "list", delta: 1 }, "closed with text: the list moves");
	assert.deepEqual(k("ArrowDown", s({ open: false, hasText: false })), { type: "reopen" });

	assert.deepEqual(k("Tab", s({ completing: true })), { type: "complete" });
	assert.equal(k("Tab", s()), null, "Tab moves focus when nothing completes");
	assert.equal(k("Tab", s({ completing: true }), { shift: true }), null);

	assert.deepEqual(k("Enter", s({ active: 1 })), { type: "choose" });
	assert.deepEqual(k("Enter", s()), { type: "openFirst" }, "nothing highlighted: open the first result");
	assert.deepEqual(k("Enter", s({ active: 1 }), { meta: true }), { type: "run" });
	assert.deepEqual(k("Enter", s(), { ctrl: true }), { type: "run" });

	assert.deepEqual(k("Escape", s()), { type: "close" }, "first Esc closes the window");
	assert.deepEqual(k("Escape", s({ open: false })), { type: "clear" }, "second Esc clears the box");
	assert.deepEqual(k("Escape", s({ open: false, hasText: false })), { type: "blur" });
	assert.equal(k("a", s()), null);

	assert.deepEqual(k("s", s(), { meta: true }), { type: "save" });
	assert.deepEqual(k("S", s({ open: false }), { ctrl: true }), { type: "save" });
	assert.equal(k("s", s({ hasText: false }), { meta: true }), null, "nothing to save");
	assert.equal(k("s", s()), null);
});

test("snippet markup and the order switch", async () => {
	const model = w;
	assert.equal(model.snippetMarkup("a <mark>b</mark> &lt;c&gt;"), "a <mark>b</mark> &lt;c&gt;");
	assert.equal(model.snippetMarkup("a <img src=x onerror=alert(1)>"), null, "any other tag: plain text instead");
	assert.equal(model.snippetMarkup("<mark onclick=x>b</mark>"), null);
	assert.equal(model.snippetMarkup(undefined), null);
	assert.equal(model.withOrder("invoice", "date"), "invoice sort:date ");
	assert.equal(model.withOrder("invoice sort:date from:ann", "relevance"), "invoice from:ann ");
	assert.equal(model.withOrder("common", "relevance", true), "common sort:relevance ");
	assert.equal(model.withOrder("sort:date", "relevance"), "");
});

test("every searched word is marked, by word start", () => {
	const m = (text, terms) => w.marks(text, terms).map((p) => (p.mark ? `[${p.text}]` : p.text)).join("");
	assert.equal(m("Re: contract draft #2", ["contract", "draft"]), "Re: [contract] [draft] #2");
	assert.equal(m("Invoices and reinvoice", ["invoice"]), "[Invoices] and reinvoice");
	assert.equal(m("Le Café", ["cafe"]), "Le [Café]");
	assert.equal(m("nothing", []), "nothing");
});
