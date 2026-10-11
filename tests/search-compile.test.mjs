import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { statements } from "./helpers/schema.mjs";
import { loadTs, openDb } from "./helpers/sqlite.mjs";

// The search compiler (workers/store/search.ts) on both schemas: the combined
// index (MailIndexDO) and D1. The same text gives the same conversations from
// the list API and the agent's tools, and no statement holds two MATCHes.

const idx = await loadTs("workers/lib/mail-index-sql.ts");
const bulk = await loadTs("workers/lib/mail-bulk-sql.ts");
const params = await loadTs("workers/lib/mail-filter-params.ts");
const tools = await loadTs("workers/lib/tools.ts");
const SCHEMA = readFileSync("migrations/0001_init.sql", "utf8");
const NOW = Date.parse("2026-10-11T12:00:00Z");
const A = "a@example.com";
const B = "b@example.org";
const iso = (hours) => new Date(NOW - hours * 3_600_000).toISOString();

// One row per message. `conv` groups a conversation; results are compared by it.
const MESSAGES = [
	{ id: 1, mailbox: A, folder: "inbox", conv: "t1", hours: 1, from: "ann@example.org", name: "Ann Lee", to: A, cc: "boss@example.net", subject: "Invoice October", body: "your invoice is attached, wire transfer details", read: 0, size: 50_000, attachment: ["invoice.pdf", "application/pdf"] },
	{ id: 2, mailbox: A, folder: "sent", conv: "t1", hours: 0.5, from: A, name: "", to: "ann@example.org", subject: "Re: Invoice October", body: "thanks, paid by wire", read: 1, size: 1000 },
	{ id: 3, mailbox: A, folder: "inbox", conv: "t2", hours: 30, from: "news@example.net", name: "News", to: A, subject: "Weekly digest", body: "this week in mail", read: 1, starred: 1, size: 1000, list: "<news.example.net>", unsubscribe: "https://example.net/u" },
	{ id: 4, mailbox: B, folder: "inbox", conv: "t3", hours: 2, from: "ann@example.org", name: "Ann", to: B, subject: "Lunch", body: "lunch on friday", read: 0, size: 6 * 1024 * 1024, attachment: ["photo.jpg", "image/jpeg"] },
	{ id: 5, mailbox: B, folder: "receipts", conv: "t4", hours: 50 * 24, from: "billing@example.net", name: "Billing", to: B, subject: "Receipt 2041", body: "receipt for your invoice", read: 1, size: 1000, label: "receipts" },
	{ id: 6, mailbox: B, folder: "trash", conv: "t5", hours: 3, from: "spam@example.net", name: "", to: B, subject: "Old offer", body: "limited offer transfer", read: 1, size: 1000 },
	{ id: 7, mailbox: A, folder: "draft", conv: "t2", hours: 0.2, from: A, name: "", to: "news@example.net", subject: "Re: Weekly digest", body: "unsubscribe me", read: 1, size: 1000, scheduled: true },
];
const state = (folder) => (["inbox", "sent", "draft", "archive", "spam", "trash"].includes(folder) ? folder : `folder:${folder}`);

function d1Db() {
	const db = openDb();
	for (const s of statements(SCHEMA)) db.exec(s);
	db.exec(`INSERT INTO mailboxes (id, created_at) VALUES (?, 'x')`, A);
	db.exec(`INSERT INTO mailboxes (id, created_at) VALUES (?, 'x')`, B);
	for (const m of [A, B]) {
		for (const f of ["inbox", "sent", "draft", "archive", "spam", "trash"]) db.exec(`INSERT INTO folders (mailbox_id, id, name) VALUES (?, ?, ?)`, m, f, f);
	}
	db.exec(`INSERT INTO folders (mailbox_id, id, name) VALUES (?, 'receipts', 'Receipts')`, B);
	db.exec(`INSERT INTO labels (id, name, color) VALUES ('receipts', 'Receipts', '#000')`);
	for (const m of MESSAGES) {
		const recipients = [m.to, m.cc].filter(Boolean).join(", ");
		db.exec(
			`INSERT INTO messages (id, email_id, mailbox_id, folder_id, conversation_id, date, subject, subject_norm, sender_addr, sender_name, sender_domain,
				recipient, cc, recipients, snippet, body, size, read, starred, has_attachment, list_id, unsubscribe)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			m.id, `e${m.id}`, m.mailbox, m.folder, m.conv, iso(m.hours), m.subject, m.subject.toLowerCase(), m.from, m.name, m.from.split("@")[1],
			m.to, m.cc ?? null, recipients, m.body, `<p>${m.body}</p>`, m.size, m.read, m.starred ?? 0, m.attachment ? 1 : 0, m.list ?? null, m.unsubscribe ?? null,
		);
		db.exec(
			`INSERT INTO messages_fts (rowid, subject, sender_name, sender_addr, recipients, body_text, attachment_names) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			m.id, m.subject, m.name, m.from, recipients, m.body, m.attachment?.[0] ?? "",
		);
		if (m.attachment) db.exec(`INSERT INTO attachments (id, email_id, filename, mimetype, size) VALUES (?, ?, ?, ?, 10)`, `a${m.id}`, `e${m.id}`, ...m.attachment);
		if (m.label) db.exec(`INSERT INTO message_labels (message, label_id) VALUES (?, ?)`, m.id, m.label);
		if (m.scheduled) db.exec(`INSERT INTO scheduled_sends (email_id, mailbox_id, send_at, payload) VALUES (?, ?, ?, '{}')`, `e${m.id}`, m.mailbox, iso(-1));
	}
	return db;
}

function indexDb() {
	const db = openDb();
	idx.createIndexSchema(db.exec);
	db.exec(`INSERT INTO labels (id, name, color) VALUES ('receipts', 'Receipts', '#000')`);
	for (const mailbox of [A, B]) {
		idx.applyRows(db.exec, mailbox, MESSAGES.filter((m) => m.mailbox === mailbox).map((m) => ({
			email_id: `e${m.id}`, seq: m.id, deleted: false, conversation_id: m.conv, message_id: `${m.id}@example.net`, state: state(m.folder),
			date: iso(m.hours), sender_addr: m.from, sender_name: m.name, sender_domain: m.from.split("@")[1], recipients: [m.to, m.cc].filter(Boolean).join(", "),
			subject: m.subject, subject_norm: m.subject.toLowerCase(), snippet: "", unread: !m.read, starred: !!m.starred, has_attachment: !!m.attachment,
			list_id: m.list ?? null, unsubscribe: m.unsubscribe ?? null, body_text: m.body, labels: m.label ? [m.label] : [],
		})), { now: NOW });
	}
	return db;
}

const DBS = { d1: d1Db(), index: indexDb() };

/** Run SQL, refusing any statement with more than one MATCH. */
function guarded(exec) {
	return (sql, ...args) => {
		const matches = sql.match(/\bMATCH\b/g)?.length ?? 0;
		assert.ok(matches <= 1, `a statement with ${matches} MATCHes:\n${sql}`);
		return exec(sql, ...args);
	};
}

/** The conversations a search finds, sorted. Also runs the facet and bulk queries over it. */
function find(engine, q, overrides = {}) {
	const exec = guarded(DBS[engine].exec);
	const filter = idx.emptyFilter({ view: "anywhere", q, engine, ...overrides });
	const page = idx.queryMail(exec, filter, { now: NOW, limit: 100 });
	idx.runSync(idx.facetsQuery(filter, NOW), exec);
	const keys = bulk.matchingThreadKeys(exec, filter, 100, NOW);
	const convs = page.conversations.map((c) => c.thread_key.split("\u001f")[1]).sort();
	assert.deepEqual([...new Set(keys.map((k) => k.split("\u001f")[1]))].sort(), convs, `bulk targets match the list for ${q}`);
	return convs;
}

// [query, conversations] on both schemas.
const BOTH = [
	["invoice", ["t1", "t4"]],
	["INVOICE octob", ["t1"]],
	[`"wire transfer"`, ["t1"]],
	[`"transfer wire"`, []],
	["wire", ["t1"]],
	["invoice -wire", ["t4"]],
	["-invoice", ["t2", "t3", "t5"]],
	[`-"limited offer" transfer`, ["t1"]],
	["from:ann", ["t1", "t3"]],
	[`from:"Ann Lee"`, ["t1"]],
	["from:example.net", ["t2", "t4", "t5"]],
	["from:@example.net", ["t2", "t4", "t5"]],
	["from:ann@example.org", ["t1", "t3"]],
	["-from:example.net", ["t1", "t2", "t3"]],
	["to:ann@example.org", ["t1"]],
	["to:b@example.org", ["t3", "t4", "t5"]],
	["subject:lunch", ["t3"]],
	[`subject:"invoice october"`, ["t1"]],
	["subject:friday", []],
	["label:Receipts", ["t4"]],
	["label:receipts invoice", ["t4"]],
	["-label:receipts invoice", ["t1"]],
	["label:nope", []],
	["in:sent invoice", ["t1"]],
	["in:receipts", ["t4"]],
	["in:trash", ["t5"]],
	["in:inbox OR in:trash", ["t1", "t2", "t3", "t5"]],
	["-in:trash offer", []],
	["in:all offer", []],
	["is:unread", ["t1", "t3"]],
	["is:read in:inbox", ["t2"]],
	["is:starred", ["t2"]],
	["is:replied", ["t1"]],
	["is:unread OR is:starred", ["t1", "t2", "t3"]],
	["has:attachment", ["t1", "t3"]],
	["has:draft", ["t2"]],
	["has:unsubscribe", ["t2"]],
	["after:2d", ["t1", "t2", "t3", "t5"]],
	["before:7d", ["t4"]],
	["older:1w", ["t4"]],
	["newer:1m -in:trash", ["t1", "t2", "t3"]],
	["after:2026-10-11", ["t1", "t2", "t3", "t5"]],
	["before:2026-10-11 in:inbox", ["t2"]],
	["after:2026-10-11T11:15:00Z", ["t1", "t2"]],
	["list:news.example.net", ["t2"]],
	["from:ann OR from:billing", ["t1", "t3", "t4"]],
	["receipt OR lunch", ["t3", "t4"]],
	["ratio:4:3", []],
];

// Operators that need D1's tables.
const D1_ONLY = [
	["cc:boss", ["t1"]],
	["cc:example.net -invoice", []],
	["is:scheduled", ["t2"]],
	["has:pdf", ["t1"]],
	["has:image", ["t3"]],
	["filename:invoice", ["t1"]],
	["filename:jpg", ["t3"]],
	[`filename:"invoice.pdf"`, ["t1"]],
	["larger:5mb", ["t3"]],
	["smaller:10k in:anywhere", ["t1", "t2", "t4", "t5"]],
	["in:Receipts", ["t4"]],
];

for (const engine of ["d1", "index"]) {
	test(`${engine}: every operator finds the expected conversations`, () => {
		for (const [q, want] of BOTH) assert.deepEqual(find(engine, q), want, q);
	});
}

test("d1: the operators that need D1's tables", () => {
	for (const [q, want] of D1_ONLY) assert.deepEqual(find("d1", q), want, q);
});

test("index: the D1-only operators are refused, not ignored", () => {
	for (const q of ["cc:boss", "is:scheduled", "has:pdf", "has:image", "filename:x", "larger:5mb", "smaller:1k"]) {
		assert.throws(() => find("index", q), /works once mail is stored in D1/, q);
	}
	assert.throws(() => find("d1", "has:link"), /isn't searchable yet/);
});

test("the view applies unless in: names where to look", () => {
	assert.deepEqual(find("d1", "offer", { view: "all" }), []);
	assert.deepEqual(find("d1", "offer in:trash", { view: "all" }), ["t5"]);
	assert.deepEqual(find("d1", "invoice", { view: "inbox" }), ["t1"]);
	assert.deepEqual(find("d1", "invoice -in:sent", { view: "anywhere" }), ["t1", "t4"]);
});

test("chips and search text compile together", () => {
	assert.deepEqual(find("d1", "invoice", { subject: ["receipt"] }), ["t4"]);
	assert.deepEqual(find("d1", "", { subject: ["lunch"], is: ["unread"] }), ["t3"]);
	assert.deepEqual(find("index", "-wire", { from: ["ann@example.org"] }), ["t3"]);
	assert.deepEqual(find("d1", "", { after: "2026-10-11", tzOffset: -14 * 60 }), ["t1", "t2", "t3", "t5"], "a day starts at the reader's midnight");
	assert.deepEqual(find("d1", "", { after: "2026-10-12", tzOffset: -14 * 60 }), ["t1", "t2", "t3"], "10-12 starts at 10:00 UTC at UTC+14");
	assert.deepEqual(find("d1", "", { after: "2026-10-12" }), []);
});

test("query syntax in user text is inert", () => {
	for (const q of [`ann@example.org "x" a-b AND OR NEAR : - ( ) * ^ {subject}:x`, `NOT invoice`, `"a""b"`, `subject:"x AND y"`, "from:NEAR(a b)", `- * " : ^`]) {
		for (const engine of ["d1", "index"]) assert.doesNotThrow(() => find(engine, q), q);
	}
	assert.deepEqual(find("d1", "NOT invoice"), [], "NOT is a word here, and no message has it");
});

test("bad values are refused with the parser's message", () => {
	assert.throws(() => find("d1", "before:soon"), /before: needs a date/);
	assert.throws(() => params.parseMailParams(new URLSearchParams({ q: "is:maybe" }), "d1"), /is: takes/);
	assert.throws(() => params.parseMailParams(new URLSearchParams({ q: "has:pdf" }), "index"), /works once mail is stored in D1/);
	assert.doesNotThrow(() => params.parseMailParams(new URLSearchParams({ q: "is:maybe" })), "without an engine the store checks it");
});

test("the list API and the agent's tools give the same conversations", () => {
	const labels = [{ id: "receipts", name: "Receipts" }];
	for (const [q] of BOTH.filter(([q]) => !q.startsWith("-") && q !== "ratio:4:3")) {
		const fromApi = params.parseMailParams(new URLSearchParams({ view: "all", q }), "d1").filter;
		const fromTool = tools.mailSearchFilter({ query: q }, labels, "d1").filter;
		const run = (filter) => idx.queryMail(DBS.d1.exec, filter, { now: NOW }).conversations.map((c) => c.thread_key);
		assert.deepEqual(run(fromTool), run(fromApi), q);
	}
	assert.match(tools.mailSearchFilter({ query: "before:soon" }, labels, "d1").error, /^before: needs a date.*The query uses the mail search language/);
	assert.match(tools.mailSearchFilter({ query: "is:scheduled" }, labels, "index").error, /works once mail is stored in D1/);
});
