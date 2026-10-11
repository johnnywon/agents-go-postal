import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const f = await loadTs("app/lib/mail-filter.ts");
const P = (s) => new URLSearchParams(s);

test("a bare URL lands on unread Inbox; an explicit view does not", () => {
	assert.deepEqual(f.parseFilter(P("")), { view: "inbox", chips: [{ kind: "is", value: "unread" }], sort: "date", dir: "desc" });
	assert.deepEqual(f.parseFilter(P("open=a@x.org:e1")).chips, [{ kind: "is", value: "unread" }]);
	assert.deepEqual(f.parseFilter(P("view=inbox")).chips, []);
});

test("URL round trip keeps chip order and drops invalid values", () => {
	const filter = f.parseFilter(P("view=all&from=Stripe.com&address=billing&is=starred&date=7d&q=invoice&sort=from&dir=asc&is=bogus&date=never&before=yesterday"));
	assert.deepEqual(filter, {
		view: "all",
		chips: [
			{ kind: "from", value: "stripe.com" }, { kind: "address", value: "billing" },
			{ kind: "is", value: "starred" }, { kind: "date", value: "7d" }, { kind: "q", value: "invoice" },
		],
		sort: "from", dir: "asc",
	});
	assert.equal(f.filterToParams(filter).toString(), "view=all&from=stripe.com&address=billing&is=starred&date=7d&q=invoice&sort=from&dir=asc");
	assert.deepEqual(f.parseFilter(f.filterToParams(filter)), filter);
	assert.equal(f.parseFilter(P("view=folder:x'1")).view, "inbox");
	assert.equal(f.parseFilter(P("view=folder:receipts")).view, "folder:receipts");
});

test("read and unread replace each other in place; single kinds replace; duplicates collapse", () => {
	let chips = [];
	chips = f.addChip(chips, { kind: "is", value: "unread" });
	chips = f.addChip(chips, { kind: "from", value: "a.com" });
	chips = f.addChip(chips, { kind: "is", value: "read" });
	chips = f.addChip(chips, { kind: "from", value: "a.com" });
	chips = f.addChip(chips, { kind: "date", value: "today" });
	chips = f.addChip(chips, { kind: "date", value: "30d" });
	chips = f.addChip(chips, { kind: "is", value: "starred" });
	assert.deepEqual(chips, [
		{ kind: "is", value: "read" }, { kind: "from", value: "a.com" }, { kind: "date", value: "30d" }, { kind: "is", value: "starred" },
	]);
	assert.deepEqual(f.removeChip(chips, { kind: "from", value: "a.com" }).map((c) => c.kind), ["is", "date", "is"]);
});

test("api params group chips by kind and carry the time zone", () => {
	const filter = f.parseFilter(P("view=inbox&from=a.com&address=billing&from=b.com"));
	assert.equal(f.apiParams(filter, 420).toString(), "view=inbox&address=billing&from=a.com&from=b.com&tz=420");
});

test("open param round trip", () => {
	assert.deepEqual(f.parseOpen(P("open=Billing@Globex.dev:abc-1")), { mailboxId: "billing@globex.dev", emailId: "abc-1" });
	assert.equal(f.parseOpen(P("open=nocolon")), null);
	assert.equal(f.toSearch(f.parseFilter(P("view=sent")), { mailboxId: "a@x.org", emailId: "e1" }), "?view=sent&open=a%40x.org%3Ae1");
});

test("search text: operators become chips, in: sets the view, the rest is text", () => {
	const parsed = f.parseSearchText(`from:ann@b.com to:billing subject:"q 3 report" subject:lunch in:archive is:Starred has:attachment before:2026-09-01 after:2026-08-01 label:x rest words`);
	assert.equal(parsed.view, "archive");
	assert.deepEqual(parsed.chips, [
		{ kind: "from", value: "ann@b.com" }, { kind: "address", value: "billing" }, { kind: "subject", value: "lunch" },
		{ kind: "is", value: "starred" }, { kind: "has", value: "attachment" }, { kind: "before", value: "2026-09-01" }, { kind: "after", value: "2026-08-01" },
	]);
	assert.equal(parsed.text, `subject:"q 3 report" label:x rest words`, "a quoted subject is a phrase, which only the server runs");
	assert.deepEqual(parsed.errors, []);
	const bad = f.parseSearchText("is:maybe in:nowhere before:soon hello");
	assert.equal(bad.text, "in:nowhere hello", "bad values are left out; a folder name stays for the server");
	assert.deepEqual(bad.errors.map((e) => e.op), ["is", "before"]);
	assert.equal(f.parseSearchText("email:foo@bar.com").text, "email:foo@bar.com");
});

test("search text the URL has no chip for stays text", () => {
	const t = (s) => f.parseSearchText(s).text;
	assert.equal(t("-from:stripe.com invoice"), "-from:stripe.com invoice");
	assert.equal(t("from:stripe.com OR from:paddle.com"), "from:stripe.com OR from:paddle.com");
	assert.equal(t("from:ann"), "from:ann", "a name is a word search on the sender");
	assert.equal(t("is:scheduled has:pdf after:30d larger:5mb in:anywhere sort:date"), "is:scheduled has:pdf after:30d larger:5mb in:anywhere sort:date");
	assert.deepEqual(f.parseSearchText("is:unread OR is:starred").chips, []);
});

const LABELS = [{ id: "receipts", name: "Receipts" }, { id: "tax-2026", name: "Tax 2026" }];

test("label: resolves a name or id to the label's id; unknown labels stay text", () => {
	assert.deepEqual(f.parseSearchText("label:receipts", LABELS).chips, [{ kind: "label", value: "receipts" }]);
	assert.deepEqual(f.parseSearchText('label:"tax 2026" invoice', LABELS), { view: undefined, chips: [{ kind: "label", value: "tax-2026" }], text: "invoice", errors: [] });
	assert.deepEqual(f.parseSearchText("label:Tax-2026", LABELS).chips, [{ kind: "label", value: "tax-2026" }]);
	assert.deepEqual(f.parseSearchText("label:nope", LABELS), { view: undefined, chips: [], text: "label:nope", errors: [] });
	assert.deepEqual(f.parseSearchText("label:receipts").chips, [], "without a label list nothing resolves");
	const next = f.applySearch({ view: "inbox", chips: [], sort: "date", dir: "desc" }, "label:Receipts label:tax-2026", LABELS);
	assert.deepEqual(next.chips, [{ kind: "label", value: "receipts" }, { kind: "label", value: "tax-2026" }]);
});

test("after the folder conversion, a custom folder link opens its label in All mail", () => {
	const labels = new Set(["receipts"]);
	assert.equal(f.legacyRedirect("/mailbox/a@x.org/emails/receipts", "", labels), "/?view=all&address=a%40x.org&label=receipts");
	assert.equal(f.legacyRedirect("/mailbox/a@x.org/emails/travel", "", labels), "/?view=folder%3Atravel&address=a%40x.org");
	assert.equal(f.legacyRedirect("/mailbox/a@x.org/emails/inbox", "", new Set(["inbox"])), "/?view=inbox&address=a%40x.org");
});
