import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

// The search language parser (shared/search-query.ts): every operator,
// quoting, exclusion, OR, bad values and unknown operators.

const q = await loadTs("shared/search-query.ts");

/** The query as text, one term per entry: the parser's view of the input. */
const terms = (input) => q.parseSearch(input).terms.map(q.formatTerm);
const errors = (input) => q.parseSearch(input).errors.map((e) => e.message);

test("words, phrases, exclusion and OR", () => {
	const cases = [
		["quarterly report", ["quarterly", "report"]],
		[`"wire transfer"`, [`"wire transfer"`]],
		[`"wire transfer" fee`, [`"wire transfer"`, "fee"]],
		[`"unclosed phrase`, [`"unclosed phrase"`]],
		[`""`, []],
		["invoice -from:stripe.com", ["invoice", "-from:stripe.com"]],
		[`-"out of office" -spam`, [`-"out of office"`, "-spam"]],
		["from:stripe.com OR from:paddle.com", ["from:stripe.com OR from:paddle.com"]],
		["a OR b OR c d", ["a OR b OR c", "d"]],
		["a or b", ["a", "or", "b"], "only upper-case OR joins"],
		["OR a", ["a"], "a leading OR is ignored"],
		["a OR", ["a"], "a trailing OR is ignored"],
		["a OR -b", ["a", "-b"], "an excluded item doesn't join"],
		["-a OR b", ["-a", "b"]],
		["a OR from: b", ["a", "b"], "an empty operator drops out and doesn't join"],
		["- a", ["-", "a"], "a lone dash is a word"],
		["-OR", ["-OR"]],
	];
	for (const [input, want, note] of cases) assert.deepEqual(terms(input), want, note ?? input);
});

test("every operator", () => {
	const cases = [
		["from:Ann@Example.org", { type: "op", op: "from", value: "ann@example.org", phrase: false }],
		[`from:"Ann Lee"`, { type: "op", op: "from", value: "ann lee", phrase: true }],
		["to:billing", { type: "op", op: "to", value: "billing", phrase: false }],
		["cc:example.net", { type: "op", op: "cc", value: "example.net", phrase: false }],
		[`subject:"Renewal Notice"`, { type: "op", op: "subject", value: "Renewal Notice", phrase: true }],
		["label:Receipts", { type: "op", op: "label", value: "Receipts", phrase: false }],
		["in:anywhere", { type: "op", op: "in", value: "anywhere", phrase: false }],
		["IN:Sent", { type: "op", op: "in", value: "sent", phrase: false }],
		["is:Unread", { type: "op", op: "is", value: "unread", phrase: false }],
		["is:replied", { type: "op", op: "is", value: "replied", phrase: false }],
		["has:pdf", { type: "op", op: "has", value: "pdf", phrase: false }],
		["filename:contract.pdf", { type: "op", op: "filename", value: "contract.pdf", phrase: false }],
		["list:news.example.org", { type: "op", op: "list", value: "news.example.org", phrase: false }],
		["after:2026-01-01", { type: "date", op: "after", value: { kind: "day", year: 2026, month: 1, day: 1 } }],
		["before:2026/2/3", { type: "date", op: "before", value: { kind: "day", year: 2026, month: 2, day: 3 } }],
		["after:2026-10-01T08:00:00Z", { type: "date", op: "after", value: { kind: "instant", iso: "2026-10-01T08:00:00.000Z" } }],
		["after:30d", { type: "date", op: "after", value: { kind: "ago", amount: 30, unit: "d" } }],
		["newer:3w", { type: "date", op: "after", value: { kind: "ago", amount: 3, unit: "w" } }],
		["older:1Y", { type: "date", op: "before", value: { kind: "ago", amount: 1, unit: "y" } }],
		["larger:5mb", { type: "size", op: "larger", bytes: 5 * 1024 * 1024 }],
		["smaller:500k", { type: "size", op: "smaller", bytes: 500 * 1024 }],
		["larger:1.5M", { type: "size", op: "larger", bytes: 1572864 }],
		["smaller:2000", { type: "size", op: "smaller", bytes: 2000 }],
	];
	for (const [input, leaf] of cases) {
		const parsed = q.parseSearch(input);
		assert.deepEqual(parsed.errors, [], input);
		assert.deepEqual(parsed.terms.map((t) => t.any), [[leaf]], input);
	}
	assert.equal(q.parseSearch("sort:Relevance invoice").sort, "relevance");
	assert.deepEqual(terms("sort:date invoice"), ["invoice"], "sort: is not a term");
});

test("unknown operators stay words", () => {
	assert.deepEqual(terms("ratio:4:3 email:foo@bar.com http://example.com"), ["ratio:4:3", "email:foo@bar.com", "http://example.com"]);
});

test("values that don't parse are left out and reported", () => {
	assert.deepEqual(terms("before:soon is:maybe has:everything larger:huge newer:2026-01-01 sort:size after:2026-02-30 hello"), ["hello"]);
	assert.deepEqual(errors("before:soon is:maybe has:everything larger:huge newer:2026-01-01 sort:size after:2026-02-30"), [
		"before: needs a date like 2026-01-31 or an age like 30d",
		"is: takes unread, read, starred, scheduled, replied",
		"has: takes attachment, unsubscribe, pdf, image, link, draft",
		"larger: needs a size like 500k or 5mb",
		"newer: needs an age like 7d, 3w, 2m or 1y",
		"sort: takes relevance, date",
		"after: needs a date like 2026-01-31 or an age like 30d",
	]);
	const [error] = q.parseSearch("hello before:soon").errors;
	assert.deepEqual([error.start, error.end, error.op, error.value], [6, 17, "before", "soon"], "errors carry their place in the text");
	assert.deepEqual(errors("from: is: "), [], "an operator with no value yet is not an error");
});

test("OR can't mix words and filters", () => {
	assert.deepEqual(terms("invoice OR is:starred receipt"), ["receipt"]);
	assert.match(errors("invoice OR is:starred")[0], /OR can't join words/);
	assert.deepEqual(terms("from:ann OR subject:lunch"), ["from:ann OR subject:lunch"], "text operators mix with words");
	assert.deepEqual(terms("is:unread OR label:x"), ["is:unread OR label:x"]);
});

test("limits", () => {
	assert.equal(q.parseSearch(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")).terms.length, q.MAX_TERMS);
	assert.match(errors(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "))[0], /up to 32 terms/);
	assert.match(errors("x".repeat(q.MAX_SEARCH_LENGTH + 1))[0], /limited to 500/);
});

test("formatting round-trips", () => {
	for (const input of [
		`invoice -from:stripe.com "wire transfer" from:a.com OR from:b.com subject:"renewal notice" label:"Tax 2026"`,
		"after:2026-01-01 before:30d larger:5mb smaller:2000 is:unread has:pdf in:anywhere filename:contract.pdf",
	]) {
		const once = q.formatSearch(q.parseSearch(input));
		assert.equal(q.formatSearch(q.parseSearch(once)), once);
	}
	assert.equal(q.formatSearch(q.parseSearch("newer:7d older:1y sort:date x")), "after:7d before:1y x sort:date");
});

test("highlight terms skip exclusions and filters", () => {
	assert.deepEqual(q.highlightTerms(q.parseSearch(`Invoice "wire transfer" -spam from:ann subject:Lunch is:unread a OR b`)), ["invoice", "wire", "transfer", "lunch", "a", "b"]);
});
