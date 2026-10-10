import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function bundle(entry) {
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		write: false,
	});
	return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { buildDirectory, FILTER_MIN, AUTO_OPEN_MAX } = await bundle("app/lib/mailbox-groups.ts");
const { createPrefsStore, directoryPrefs, PREFS_KEY } = await bundle("app/lib/directory-prefs.ts");

const mailboxes = (...emails) => emails.map((email) => ({ id: email, email }));
const build_ = (overrides = {}) => buildDirectory({ mailboxes: [], pinned: [], open: {}, query: "", ...overrides });
const ids = (rows) => rows.map((row) => row.id);
const domains = (model) => model.groups.map((group) => group.domain);

const roster = mailboxes(
	"hello@wayne.org",
	"abuse@wayne.org",
	"hello@globex.dev",
	"postmaster@globex.dev",
	"ops@piedpiper.io",
);

test("constants match the spec", () => {
	assert.equal(FILTER_MIN, 12);
	assert.equal(AUTO_OPEN_MAX, 24);
});

test("groups sort A-Z by domain with Other last", () => {
	const model = build_({ mailboxes: mailboxes("a@zed.io", "root", "b@Alpha.org", "c@mid.net", "d@alpha.ORG") });
	assert.deepEqual(domains(model), ["alpha.org", "mid.net", "zed.io", "Other"]);
	assert.deepEqual(ids(model.groups[0].rows), ["b@Alpha.org", "d@alpha.ORG"]);
	assert.deepEqual(ids(model.groups[3].rows), ["root"]);
});

test("a real domain named other sorts before the Other bucket", () => {
	const model = build_({ mailboxes: mailboxes("x@other", "plain", "y@zzz.io") });
	assert.deepEqual(domains(model), ["other", "zzz.io", "Other"]);
});

test("rows sort by local part then email, ignoring case", () => {
	const model = build_({
		mailboxes: mailboxes("zed@w.org", "Beta@w.org", "alpha@w.org", "beta-2@w.org", "beta.x@w.org", "b@w.org"),
	});
	assert.deepEqual(ids(model.groups[0].rows), ["alpha@w.org", "b@w.org", "Beta@w.org", "beta-2@w.org", "beta.x@w.org", "zed@w.org"]);
});

test("the same local part on two domains stays two rows", () => {
	const model = build_({ mailboxes: roster });
	const hello = model.groups.flatMap((group) => group.rows).filter((row) => row.local === "hello");
	assert.deepEqual(hello.map((row) => row.domain), ["globex.dev", "wayne.org"]);
	assert.equal(model.total, 5);
	assert.equal(model.shown, 5);
});

test("row fields split the email and keep the original id", () => {
	const model = build_({ mailboxes: [{ id: "Hello@Wayne.ORG", email: "Hello@Wayne.ORG" }] });
	assert.deepEqual(model.groups[0].rows[0], { id: "Hello@Wayne.ORG", email: "Hello@Wayne.ORG", local: "Hello", domain: "wayne.org" });
});

test("pinned is a copy: the domain group stays complete", () => {
	const model = build_({ mailboxes: roster, pinned: ["postmaster@globex.dev", "abuse@wayne.org"] });
	assert.deepEqual(ids(model.pinned), ["abuse@wayne.org", "postmaster@globex.dev"]);
	const golf = model.groups.find((group) => group.domain === "globex.dev");
	assert.deepEqual(ids(golf.rows), ["hello@globex.dev", "postmaster@globex.dev"]);
	assert.equal(model.groups.flatMap((group) => group.rows).length, 5);
});

test("pinned sorts by local part then domain, not by pin order", () => {
	const model = build_({ mailboxes: roster, pinned: ["ops@piedpiper.io", "hello@wayne.org", "hello@globex.dev", "abuse@wayne.org"] });
	assert.deepEqual(ids(model.pinned), ["abuse@wayne.org", "hello@globex.dev", "hello@wayne.org", "ops@piedpiper.io"]);
});

test("unknown pinned ids are ignored and not an error", () => {
	const model = build_({ mailboxes: roster, pinned: ["gone@wayne.org", "", "hello@wayne.org"] });
	assert.deepEqual(ids(model.pinned), ["hello@wayne.org"]);
});

test("pinned ids match case-insensitively and de-duplicate", () => {
	const model = build_({
		mailboxes: [{ id: "Hello@Wayne.org", email: "Hello@Wayne.org" }, ...mailboxes("b@wayne.org")],
		pinned: ["hello@wayne.org", "HELLO@WAYNE.ORG", "hello@wayne.org"],
	});
	assert.deepEqual(ids(model.pinned), ["Hello@Wayne.org"]);
});

test("currentKey is pinned:<id> when the active mailbox is pinned, else group:<id>", () => {
	const pinned = build_({ mailboxes: roster, pinned: ["hello@wayne.org"], activeId: "hello@wayne.org" });
	assert.equal(pinned.currentKey, "pinned:hello@wayne.org");
	const unpinned = build_({ mailboxes: roster, pinned: ["hello@wayne.org"], activeId: "ops@piedpiper.io" });
	assert.equal(unpinned.currentKey, "group:ops@piedpiper.io");
});

test("currentKey is null without a known active mailbox", () => {
	assert.equal(build_({ mailboxes: roster }).currentKey, null);
	assert.equal(build_({ mailboxes: roster, activeId: "" }).currentKey, null);
	assert.equal(build_({ mailboxes: roster, activeId: "nobody@wayne.org" }).currentKey, null);
});

test("activeId matches case-insensitively and currentKey carries the listed id", () => {
	const model = build_({
		mailboxes: [{ id: "Hello@Wayne.org", email: "Hello@Wayne.org" }],
		pinned: ["hello@wayne.org"],
		activeId: "HELLO@wayne.ORG",
	});
	assert.equal(model.currentKey, "pinned:Hello@Wayne.org");
	assert.equal(model.groups[0].hasActive, true);
});

test("currentKey is null while the filter hides the active mailbox", () => {
	const hidden = build_({ mailboxes: roster, activeId: "ops@piedpiper.io", query: "wayne" });
	assert.equal(hidden.currentKey, null);
	assert.ok(hidden.groups.every((group) => !group.hasActive));
	const shown = build_({ mailboxes: roster, activeId: "ops@piedpiper.io", query: "pied" });
	assert.equal(shown.currentKey, "group:ops@piedpiper.io");
	assert.equal(shown.groups[0].hasActive, true);
});

test("hasActive marks only the group that holds the active mailbox", () => {
	const model = build_({ mailboxes: roster, activeId: "abuse@wayne.org" });
	assert.deepEqual(model.groups.map((group) => [group.domain, group.hasActive]), [
		["globex.dev", false],
		["piedpiper.io", false],
		["wayne.org", true],
	]);
});

test("filter: a short token matches inside the address", () => {
	const model = build_({ mailboxes: roster, query: "glo" });
	assert.equal(model.filtering, true);
	assert.deepEqual(domains(model), ["globex.dev"]);
	assert.deepEqual(ids(model.groups[0].rows), ["hello@globex.dev", "postmaster@globex.dev"]);
	assert.equal(model.shown, 2);
	assert.equal(model.total, 5);
});

test("filter: every whitespace-separated token must match, in any order", () => {
	const model = build_({ mailboxes: roster, query: "hello wayne" });
	assert.deepEqual(ids(model.groups.flatMap((group) => group.rows)), ["hello@wayne.org"]);
	assert.deepEqual(ids(build_({ mailboxes: roster, query: "wayne hello" }).groups.flatMap((group) => group.rows)), ["hello@wayne.org"]);
	assert.deepEqual(ids(build_({ mailboxes: roster, query: "  hello \t wayne  " }).groups.flatMap((group) => group.rows)), ["hello@wayne.org"]);
});

test("filter: one token across domains drops the groups with no match", () => {
	const model = build_({ mailboxes: roster, query: "hello" });
	assert.deepEqual(domains(model), ["globex.dev", "wayne.org"]);
	assert.equal(model.shown, 2);
});

test("filter is case-insensitive", () => {
	const model = build_({ mailboxes: roster, query: "HeLLo WAYNE" });
	assert.deepEqual(ids(model.groups.flatMap((group) => group.rows)), ["hello@wayne.org"]);
	const upper = build_({ mailboxes: mailboxes("Hello@Wayne.org"), query: "hello@wayne" });
	assert.equal(upper.shown, 1);
});

test("filter can match on the domain alone", () => {
	const model = build_({ mailboxes: roster, query: "globex.dev" });
	assert.deepEqual(domains(model), ["globex.dev"]);
	assert.equal(model.shown, 2);
	assert.equal(build_({ mailboxes: roster, query: "@wayne.org" }).shown, 2);
	assert.equal(build_({ mailboxes: roster, query: "ORG" }).shown, 2);
});

test("filter does not match the group label", () => {
	const model = build_({ mailboxes: mailboxes("root", "a@w.org"), query: "other" });
	assert.equal(model.shown, 0);
	assert.deepEqual(model.groups, []);
});

test("filter hides Pinned and forces every remaining group open", () => {
	const model = build_({
		mailboxes: roster,
		pinned: ["hello@wayne.org"],
		open: { "wayne.org": false },
		query: "hello",
	});
	assert.deepEqual(model.pinned, []);
	assert.ok(model.groups.length > 0 && model.groups.every((group) => group.open === true));
});

test("filter with no match leaves nothing and no firstMatch", () => {
	const model = build_({ mailboxes: roster, query: "zzz" });
	assert.equal(model.filtering, true);
	assert.equal(model.shown, 0);
	assert.equal(model.total, 5);
	assert.deepEqual(model.groups, []);
	assert.equal(model.firstMatch, null);
	assert.equal(model.currentKey, null);
});

test("firstMatch is the first row in DOM order", () => {
	const model = build_({ mailboxes: roster, query: "hello" });
	assert.equal(model.firstMatch.id, "hello@globex.dev");
	assert.equal(model.firstMatch, model.groups[0].rows[0]);
	assert.equal(build_({ mailboxes: roster, query: "wayne" }).firstMatch.id, "abuse@wayne.org");
});

test("firstMatch follows group order, with Other last", () => {
	const model = build_({ mailboxes: mailboxes("hello", "hello@zzz.io"), query: "hello" });
	assert.equal(model.firstMatch.id, "hello@zzz.io");
});

test("whitespace-only and empty queries do not filter", () => {
	for (const query of ["", " ", "   \t\n", undefined]) {
		const model = build_({ mailboxes: roster, pinned: ["hello@wayne.org"], query });
		assert.equal(model.filtering, false, JSON.stringify(query));
		assert.equal(model.shown, 5);
		assert.equal(model.firstMatch, null);
		assert.deepEqual(ids(model.pinned), ["hello@wayne.org"]);
	}
});

test("open rule: all groups open up to 24 mailboxes, only the active domain at 25", () => {
	const make = (count) => mailboxes(...Array.from({ length: count }, (_, i) => `m${i}@d${i % 3}.org`));
	const at24 = build_({ mailboxes: make(24), activeId: "m1@d1.org" });
	assert.equal(at24.total, 24);
	assert.deepEqual(at24.groups.map((group) => group.open), [true, true, true]);

	const at25 = build_({ mailboxes: make(25), activeId: "m1@d1.org" });
	assert.equal(at25.total, 25);
	assert.deepEqual(at25.groups.map((group) => [group.domain, group.open]), [["d0.org", false], ["d1.org", true], ["d2.org", false]]);

	const noActive = build_({ mailboxes: make(25) });
	assert.ok(noActive.groups.every((group) => group.open === false));
});

test("open rule: an active mailbox that is not in the list opens nothing at 25", () => {
	const list = mailboxes(...Array.from({ length: 25 }, (_, i) => `m${i}@d${i % 2}.org`));
	const model = build_({ mailboxes: list, activeId: "ghost@d0.org" });
	assert.ok(model.groups.every((group) => group.open === false));
});

test("open rule: an explicit choice wins over the default", () => {
	const make = (count) => mailboxes(...Array.from({ length: count }, (_, i) => `m${i}@d${i % 3}.org`));
	const closed = build_({ mailboxes: make(12), open: { "d1.org": false } });
	assert.deepEqual(closed.groups.map((group) => group.open), [true, false, true]);

	const opened = build_({ mailboxes: make(30), open: { "d2.org": true }, activeId: "m0@d0.org" });
	assert.deepEqual(opened.groups.map((group) => group.open), [true, false, true]);

	const closedActive = build_({ mailboxes: make(30), open: { "d0.org": false }, activeId: "m0@d0.org" });
	assert.equal(closedActive.groups[0].open, false);
	assert.equal(closedActive.groups[0].hasActive, true);
});

test("open rule: stored domain keys match regardless of case", () => {
	const model = build_({ mailboxes: mailboxes("a@wayne.org"), open: { "Wayne.ORG": false } });
	assert.equal(model.groups[0].open, false);
});

test("open rule: the Other group reads the stored key other", () => {
	const model = build_({ mailboxes: mailboxes("root", "a@w.org"), open: { other: false } });
	assert.deepEqual(model.groups.map((group) => [group.domain, group.open]), [["w.org", true], ["Other", false]]);
});

test("open rule: a domain named like an Object property is not read from the prototype", () => {
	const model = build_({ mailboxes: mailboxes("a@constructor", "b@toString", "c@__proto__"), open: {} });
	assert.deepEqual(model.groups.map((group) => group.open), [true, true, true]);
});

test("open rule: non-boolean stored values are ignored", () => {
	const model = build_({ mailboxes: mailboxes("a@w.org"), open: { "w.org": "no" } });
	assert.equal(model.groups[0].open, true);
});

test("empty mailbox list", () => {
	const model = build_({ mailboxes: [], pinned: ["a@w.org"], activeId: "a@w.org" });
	assert.deepEqual(model, { total: 0, shown: 0, filtering: false, pinned: [], groups: [], currentKey: null, firstMatch: null });
	const filtered = build_({ mailboxes: [], query: "x" });
	assert.equal(filtered.filtering, true);
	assert.equal(filtered.shown, 0);
	assert.equal(filtered.firstMatch, null);
});

test("an email with no @ goes to Other and keeps the whole address as its local part", () => {
	const model = build_({ mailboxes: mailboxes("postmaster", "a@w.org") });
	assert.deepEqual(domains(model), ["w.org", "Other"]);
	assert.deepEqual(model.groups[1].rows[0], { id: "postmaster", email: "postmaster", local: "postmaster", domain: "Other" });
});

test("an email with two @ splits at the last one", () => {
	const model = build_({ mailboxes: mailboxes("a@b@Example.com") });
	assert.deepEqual(model.groups[0].rows[0], { id: "a@b@Example.com", email: "a@b@Example.com", local: "a@b", domain: "example.com" });
});

test("an email that starts or ends with @ has no usable split", () => {
	const model = build_({ mailboxes: mailboxes("@wayne.org", "name@") });
	assert.deepEqual(domains(model), ["Other"]);
	assert.deepEqual(model.groups[0].rows.map((row) => row.local), ["@wayne.org", "name@"]);
});

test("surrounding whitespace in an email does not leak into the domain", () => {
	const model = build_({ mailboxes: [{ id: "a", email: "  a@w.org  " }] });
	assert.equal(model.groups[0].rows[0].domain, "w.org");
	assert.equal(model.groups[0].rows[0].local, "a");
	assert.equal(build_({ mailboxes: [{ id: "a", email: "  a@w.org  " }], query: "org" }).shown, 1);
});

test("domains with different casing share one group", () => {
	const model = build_({ mailboxes: mailboxes("a@Wayne.org", "b@WAYNE.ORG", "c@wayne.org") });
	assert.deepEqual(domains(model), ["wayne.org"]);
	assert.equal(model.groups[0].rows.length, 3);
});

test("duplicate ids collapse to one row and one count", () => {
	const model = build_({
		mailboxes: [
			{ id: "a@w.org", email: "a@w.org" },
			{ id: "A@W.org", email: "A@W.org" },
			{ id: "a@w.org", email: "a@w.org" },
			{ id: "b@w.org", email: "b@w.org" },
		],
	});
	assert.equal(model.total, 2);
	assert.equal(model.shown, 2);
	assert.deepEqual(ids(model.groups[0].rows), ["a@w.org", "b@w.org"]);
});

test("a mailbox with no email falls back to its id", () => {
	const model = build_({ mailboxes: [{ id: "a@w.org", email: "" }, { id: "b@w.org" }] });
	assert.deepEqual(model.groups[0].rows.map((row) => [row.id, row.email, row.local]), [
		["a@w.org", "a@w.org", "a"],
		["b@w.org", "b@w.org", "b"],
	]);
});

test("entries without a usable id are skipped", () => {
	const model = build_({ mailboxes: [null, { id: "", email: "x@w.org" }, { email: "y@w.org" }, { id: "ok@w.org", email: "ok@w.org" }] });
	assert.equal(model.total, 1);
});

test("output does not depend on input order and inputs are not mutated", () => {
	const forward = Object.freeze(roster.map((m) => Object.freeze({ ...m })));
	const reverse = Object.freeze([...forward].reverse());
	const pinned = Object.freeze(["ops@piedpiper.io", "abuse@wayne.org"]);
	const open = Object.freeze({ "wayne.org": false });
	const a = build_({ mailboxes: forward, pinned, open, activeId: "ops@piedpiper.io" });
	const b = build_({ mailboxes: reverse, pinned: [...pinned].reverse(), open, activeId: "ops@piedpiper.io" });
	assert.deepEqual(a, b);
	assert.deepEqual(pinned, ["ops@piedpiper.io", "abuse@wayne.org"]);
});

test("nineteen mailboxes on three domains group and count", () => {
	const wayne = ["abuse", "admin", "billing", "contact", "hello", "info", "jobs", "legal", "noreply", "ops", "postmaster", "security", "support"];
	const golf = ["api", "hello", "postmaster", "support"];
	const model = build_({
		mailboxes: [
			...wayne.map((l) => ({ id: `${l}@wayne.org`, email: `${l}@wayne.org` })),
			...golf.map((l) => ({ id: `${l}@globex.dev`, email: `${l}@globex.dev` })),
			...["ops", "sales"].map((l) => ({ id: `${l}@piedpiper.io`, email: `${l}@piedpiper.io` })),
		],
		activeId: "hello@wayne.org",
	});
	assert.equal(model.total, 19);
	assert.deepEqual(model.groups.map((group) => [group.domain, group.rows.length, group.open]), [
		["globex.dev", 4, true],
		["piedpiper.io", 2, true],
		["wayne.org", 13, true],
	]);
	assert.ok(model.total >= FILTER_MIN);
});

// Prefs store

function fakeStorage(initial = {}) {
	const data = new Map(Object.entries(initial));
	const storage = {
		data,
		reads: 0,
		writes: 0,
		failGet: false,
		failSet: false,
		getItem(key) {
			storage.reads++;
			if (storage.failGet) throw new Error("getItem blocked");
			return data.has(key) ? data.get(key) : null;
		},
		setItem(key, value) {
			if (storage.failSet) throw new Error("QuotaExceededError");
			storage.writes++;
			data.set(key, String(value));
		},
	};
	return storage;
}

const memoryStore = () => {
	const storage = fakeStorage();
	return createPrefsStore(() => storage);
};
const stored = (storage) => JSON.parse(storage.data.get(PREFS_KEY));
const blob = (pinned = [], open = {}, v = 1) => JSON.stringify({ v, pinned, open });

function counter() {
	const fn = () => {
		fn.calls++;
	};
	fn.calls = 0;
	return fn;
}

test("a fresh store reads defaults and the snapshot is one stable object", () => {
	const storage = fakeStorage();
	const store = createPrefsStore(() => storage);
	const first = store.getSnapshot();
	assert.deepEqual(first, { pinned: [], open: {}, persistent: true });
	assert.equal(store.getSnapshot(), first);
	assert.equal(store.getSnapshot(), first);
	assert.equal(storage.reads, 1);
});

test("nothing touches storage until the first client snapshot", () => {
	let calls = 0;
	const store = createPrefsStore(() => {
		calls++;
		return fakeStorage();
	});
	assert.equal(calls, 0);
	store.getServerSnapshot();
	assert.equal(calls, 0);
	store.getSnapshot();
	assert.equal(calls, 1);
});

test("the server snapshot is one frozen constant shared by every store", () => {
	const a = createPrefsStore(() => fakeStorage({ [PREFS_KEY]: blob(["x@w.org"]) }));
	const b = createPrefsStore(() => null);
	const server = a.getServerSnapshot();
	assert.deepEqual(server, { pinned: [], open: {}, persistent: true });
	assert.equal(a.getServerSnapshot(), server);
	assert.equal(b.getServerSnapshot(), server);
	a.togglePin("y@w.org");
	assert.equal(a.getServerSnapshot(), server);
	assert.deepEqual(server, { pinned: [], open: {}, persistent: true });
	assert.ok(Object.isFrozen(server) && Object.isFrozen(server.pinned) && Object.isFrozen(server.open));
});

test("stored prefs load, lowercased and de-duplicated", () => {
	const storage = fakeStorage({
		[PREFS_KEY]: blob(["B@W.org", "a@w.org", "b@w.org", "", "A@W.ORG"], { "Wayne.ORG": false, "globex.dev": true, "": true, "bad.io": "no" }),
	});
	const snapshot = createPrefsStore(() => storage).getSnapshot();
	assert.deepEqual(snapshot.pinned, ["b@w.org", "a@w.org"]);
	assert.deepEqual(snapshot.open, { "wayne.org": false, "globex.dev": true });
	assert.equal(snapshot.persistent, true);
});

for (const [name, raw] of [
	["invalid JSON", "{not json"],
	["empty string", ""],
	["JSON null", "null"],
	["JSON string", '"pins"'],
	["JSON number", "7"],
	["JSON array", "[]"],
	["wrong version", blob(["a@w.org"], { "w.org": false }, 2)],
	["missing version", JSON.stringify({ pinned: ["a@w.org"], open: {} })],
	["string version", blob(["a@w.org"], {}, "1")],
	["pinned not an array", JSON.stringify({ v: 1, pinned: "a@w.org", open: {} })],
	["pinned with a non-string", JSON.stringify({ v: 1, pinned: ["a@w.org", 3], open: {} })],
	["pinned missing", JSON.stringify({ v: 1, open: {} })],
	["open is an array", JSON.stringify({ v: 1, pinned: [], open: [] })],
	["open is null", JSON.stringify({ v: 1, pinned: [], open: null })],
	["open is a string", JSON.stringify({ v: 1, pinned: [], open: "x" })],
	["open missing", JSON.stringify({ v: 1, pinned: [] })],
]) {
	test(`bad stored data (${name}) reads as defaults, then the first pin overwrites it`, () => {
		const storage = fakeStorage({ [PREFS_KEY]: raw });
		const store = createPrefsStore(() => storage);
		assert.deepEqual(store.getSnapshot(), { pinned: [], open: {}, persistent: true });
		assert.equal(store.togglePin("A@w.org"), true);
		assert.deepEqual(store.getSnapshot(), { pinned: ["a@w.org"], open: {}, persistent: true });
		assert.deepEqual(stored(storage), { v: 1, pinned: ["a@w.org"], open: {} });
	});
}

test("a stored __proto__ key does not change the open object's prototype", () => {
	const storage = fakeStorage({ [PREFS_KEY]: '{"v":1,"pinned":[],"open":{"__proto__":false,"a.org":true}}' });
	const store = createPrefsStore(() => storage);
	const { open } = store.getSnapshot();
	assert.equal(Object.getPrototypeOf(open), Object.prototype);
	assert.equal(open["a.org"], true);
	assert.equal(Object.hasOwn(open, "__proto__"), true);
	assert.equal({}.a, undefined);
	store.setOpen("__proto__", true);
	assert.equal(Object.getPrototypeOf(store.getSnapshot().open), Object.prototype);
});

test("getStorage throwing gives defaults, persistent false, and pins still work in memory", () => {
	const store = createPrefsStore(() => {
		throw new Error("SecurityError");
	});
	const notify = counter();
	store.subscribe(notify);
	assert.deepEqual(store.getSnapshot(), { pinned: [], open: {}, persistent: false });
	assert.equal(store.togglePin("a@w.org"), true);
	assert.equal(store.togglePin("b@w.org"), true);
	store.setOpen("w.org", false);
	assert.deepEqual(store.getSnapshot(), { pinned: ["a@w.org", "b@w.org"], open: { "w.org": false }, persistent: false });
	assert.equal(store.togglePin("a@w.org"), false);
	assert.deepEqual(store.getSnapshot().pinned, ["b@w.org"]);
	assert.equal(notify.calls, 4);
});

test("getStorage returning null behaves like blocked storage", () => {
	const store = createPrefsStore(() => null);
	assert.deepEqual(store.getSnapshot(), { pinned: [], open: {}, persistent: false });
	assert.equal(store.togglePin("a@w.org"), true);
	assert.deepEqual(store.getSnapshot().pinned, ["a@w.org"]);
	assert.equal(store.getSnapshot().persistent, false);
});

test("getItem throwing gives defaults and persistent false", () => {
	const storage = fakeStorage({ [PREFS_KEY]: blob(["a@w.org"]) });
	storage.failGet = true;
	const store = createPrefsStore(() => storage);
	assert.deepEqual(store.getSnapshot(), { pinned: [], open: {}, persistent: false });
	assert.equal(store.togglePin("b@w.org"), true);
	assert.deepEqual(store.getSnapshot().pinned, ["b@w.org"]);
});

test("setItem throwing keeps the pin in memory and flips persistent to false", () => {
	const storage = fakeStorage();
	storage.failSet = true;
	const store = createPrefsStore(() => storage);
	assert.equal(store.getSnapshot().persistent, true);
	assert.equal(store.togglePin("a@w.org"), true);
	assert.deepEqual(store.getSnapshot(), { pinned: ["a@w.org"], open: {}, persistent: false });
	store.setOpen("w.org", false);
	assert.deepEqual(store.getSnapshot(), { pinned: ["a@w.org"], open: { "w.org": false }, persistent: false });
	assert.equal(storage.data.has(PREFS_KEY), false);

	storage.failSet = false;
	store.togglePin("b@w.org");
	assert.equal(store.getSnapshot().persistent, true);
	assert.deepEqual(stored(storage), { v: 1, pinned: ["a@w.org", "b@w.org"], open: { "w.org": false } });
});

test("a blocked reload keeps the in-memory prefs and marks them unsaved", () => {
	const storage = fakeStorage();
	const store = createPrefsStore(() => storage);
	store.togglePin("a@w.org");
	const notify = counter();
	store.subscribe(notify);
	storage.failGet = true;
	store.reload();
	assert.deepEqual(store.getSnapshot(), { pinned: ["a@w.org"], open: {}, persistent: false });
	assert.equal(notify.calls, 1);
	store.reload();
	assert.equal(notify.calls, 1);
});

test("pins and domains are stored lowercased and pins are not duplicated", () => {
	const storage = fakeStorage();
	const store = createPrefsStore(() => storage);
	assert.equal(store.togglePin("Hello@Wayne.ORG"), true);
	assert.deepEqual(store.getSnapshot().pinned, ["hello@wayne.org"]);
	assert.equal(store.togglePin("HELLO@wayne.org"), false);
	assert.deepEqual(store.getSnapshot().pinned, []);
	store.togglePin("a@w.org");
	store.togglePin("b@w.org");
	store.setOpen("Wayne.ORG", false);
	store.setOpen("wayne.org", true);
	assert.deepEqual(stored(storage), { v: 1, pinned: ["a@w.org", "b@w.org"], open: { "wayne.org": true } });
});

test("empty ids and domains are ignored without a notification or write", () => {
	const storage = fakeStorage();
	const store = createPrefsStore(() => storage);
	const notify = counter();
	store.subscribe(notify);
	const before = store.getSnapshot();
	assert.equal(store.togglePin(""), false);
	store.setOpen("", true);
	assert.equal(store.getSnapshot(), before);
	assert.equal(notify.calls, 0);
	assert.equal(storage.writes, 0);
});

test("only explicit choices are stored", () => {
	const storage = fakeStorage();
	const store = createPrefsStore(() => storage);
	store.getSnapshot();
	store.reload();
	assert.equal(storage.writes, 0);
	assert.equal(storage.data.size, 0);
	store.setOpen("w.org", true);
	assert.deepEqual(stored(storage), { v: 1, pinned: [], open: { "w.org": true } });
});

test("snapshot identity changes only when state changes", () => {
	const storage = fakeStorage();
	const store = createPrefsStore(() => storage);
	const s0 = store.getSnapshot();
	assert.equal(store.getSnapshot(), s0);

	store.togglePin("a@w.org");
	const s1 = store.getSnapshot();
	assert.notEqual(s1, s0);
	assert.equal(store.getSnapshot(), s1);

	store.setOpen("w.org", false);
	const s2 = store.getSnapshot();
	assert.notEqual(s2, s1);

	const writes = storage.writes;
	store.setOpen("w.org", false);
	store.setOpen("W.ORG", false);
	assert.equal(store.getSnapshot(), s2);
	assert.equal(storage.writes, writes);

	store.reload();
	assert.equal(store.getSnapshot(), s2);

	store.togglePin("a@w.org");
	assert.notEqual(store.getSnapshot(), s2);
});

test("old snapshots are never edited in place", () => {
	const store = memoryStore();
	const s0 = store.getSnapshot();
	store.togglePin("a@w.org");
	const s1 = store.getSnapshot();
	store.togglePin("b@w.org");
	store.setOpen("w.org", false);
	assert.deepEqual(s0, { pinned: [], open: {}, persistent: true });
	assert.deepEqual(s1, { pinned: ["a@w.org"], open: {}, persistent: true });
	assert.notEqual(s0.pinned, s1.pinned);
	assert.notEqual(s0.open, store.getSnapshot().open);
});

test("methods work unbound, as useSyncExternalStore receives them", () => {
	const storage = fakeStorage();
	const { getSnapshot, getServerSnapshot, subscribe, togglePin, setOpen, reload } = createPrefsStore(() => storage);
	const notify = counter();
	const off = subscribe(notify);
	togglePin("a@w.org");
	setOpen("w.org", false);
	reload();
	assert.deepEqual(getSnapshot().pinned, ["a@w.org"]);
	assert.equal(getServerSnapshot().pinned.length, 0);
	assert.equal(notify.calls, 2);
	off();
});

test("subscribers hear every change and stop after unsubscribing", () => {
	const store = memoryStore();
	const a = counter();
	const b = counter();
	const offA = store.subscribe(a);
	store.subscribe(b);
	store.togglePin("a@w.org");
	store.setOpen("w.org", false);
	assert.deepEqual([a.calls, b.calls], [2, 2]);
	offA();
	offA();
	store.togglePin("b@w.org");
	assert.deepEqual([a.calls, b.calls], [2, 3]);
});

test("the same function subscribed twice is two subscriptions", () => {
	const store = memoryStore();
	const notify = counter();
	const off1 = store.subscribe(notify);
	const off2 = store.subscribe(notify);
	store.togglePin("a@w.org");
	assert.equal(notify.calls, 2);
	off1();
	store.togglePin("b@w.org");
	assert.equal(notify.calls, 3);
	off2();
	store.togglePin("c@w.org");
	assert.equal(notify.calls, 3);
});

test("a listener that unsubscribes during a notification does not skip the others", () => {
	const store = memoryStore();
	const later = counter();
	let off;
	off = store.subscribe(() => off());
	store.subscribe(later);
	store.togglePin("a@w.org");
	assert.equal(later.calls, 1);
});

test("the snapshot is readable the moment a listener runs", () => {
	const store = memoryStore();
	let seen;
	store.subscribe(() => {
		seen = store.getSnapshot().pinned.slice();
	});
	store.togglePin("a@w.org");
	assert.deepEqual(seen, ["a@w.org"]);
});

test("reload picks up an external write, notifies once, and keeps identity when nothing changed", () => {
	const storage = fakeStorage({ [PREFS_KEY]: blob(["a@w.org"]) });
	const store = createPrefsStore(() => storage);
	const before = store.getSnapshot();
	const notify = counter();
	store.subscribe(notify);

	store.reload();
	assert.equal(store.getSnapshot(), before);
	assert.equal(notify.calls, 0);

	storage.data.set(PREFS_KEY, blob(["A@w.org", "b@w.org"], { "W.org": false }));
	store.reload();
	assert.notEqual(store.getSnapshot(), before);
	assert.deepEqual(store.getSnapshot(), { pinned: ["a@w.org", "b@w.org"], open: { "w.org": false }, persistent: true });
	assert.equal(notify.calls, 1);

	store.reload();
	assert.equal(notify.calls, 1);

	storage.data.delete(PREFS_KEY);
	store.reload();
	assert.deepEqual(store.getSnapshot(), { pinned: [], open: {}, persistent: true });
	assert.equal(notify.calls, 2);
});

test("a pin made after an external write builds on the loaded state", () => {
	const storage = fakeStorage({ [PREFS_KEY]: blob(["a@w.org"], { "w.org": false }) });
	const store = createPrefsStore(() => storage);
	store.togglePin("b@w.org");
	assert.deepEqual(stored(storage), { v: 1, pinned: ["a@w.org", "b@w.org"], open: { "w.org": false } });
});

test("pins for mailboxes that no longer exist stay stored", () => {
	const storage = fakeStorage({ [PREFS_KEY]: blob(["gone@w.org", "here@w.org"]) });
	const store = createPrefsStore(() => storage);
	store.setOpen("w.org", false);
	assert.deepEqual(stored(storage).pinned, ["gone@w.org", "here@w.org"]);
	const model = build_({ mailboxes: mailboxes("here@w.org"), pinned: store.getSnapshot().pinned });
	assert.deepEqual(ids(model.pinned), ["here@w.org"]);
});

test("one window storage listener exists while anyone is subscribed", () => {
	const previous = globalThis.window;
	const target = new EventTarget();
	const adds = [];
	const removes = [];
	const add = target.addEventListener.bind(target);
	const remove = target.removeEventListener.bind(target);
	target.addEventListener = (type, fn) => (adds.push(type), add(type, fn));
	target.removeEventListener = (type, fn) => (removes.push(type), remove(type, fn));
	globalThis.window = target;
	try {
		const storage = fakeStorage({ [PREFS_KEY]: blob(["a@w.org"]) });
		const store = createPrefsStore(() => storage);
		const notify = counter();
		store.getSnapshot();
		assert.deepEqual(adds, []);

		const off1 = store.subscribe(notify);
		const off2 = store.subscribe(counter());
		assert.deepEqual(adds, ["storage"]);

		storage.data.set(PREFS_KEY, blob(["a@w.org", "b@w.org"]));
		target.dispatchEvent(new Event("storage"));
		assert.deepEqual(store.getSnapshot().pinned, ["a@w.org", "b@w.org"]);
		assert.equal(notify.calls, 1);

		const reads = storage.reads;
		const unrelated = new Event("storage");
		Object.defineProperty(unrelated, "key", { value: "some-other-key" });
		target.dispatchEvent(unrelated);
		assert.equal(storage.reads, reads);

		storage.data.set(PREFS_KEY, blob(["c@w.org"]));
		const own = new Event("storage");
		Object.defineProperty(own, "key", { value: PREFS_KEY });
		target.dispatchEvent(own);
		assert.deepEqual(store.getSnapshot().pinned, ["c@w.org"]);

		storage.data.delete(PREFS_KEY);
		const cleared = new Event("storage");
		Object.defineProperty(cleared, "key", { value: null });
		target.dispatchEvent(cleared);
		assert.deepEqual(store.getSnapshot().pinned, []);

		off1();
		assert.deepEqual(removes, []);
		off2();
		assert.deepEqual(removes, ["storage"]);

		const calls = notify.calls;
		storage.data.set(PREFS_KEY, blob(["z@w.org"]));
		target.dispatchEvent(new Event("storage"));
		assert.equal(notify.calls, calls);

		const off3 = store.subscribe(counter());
		assert.deepEqual(adds, ["storage", "storage"]);
		off3();
	} finally {
		if (previous === undefined) delete globalThis.window;
		else globalThis.window = previous;
	}
});

test("subscribe works where there is no window", () => {
	assert.equal(typeof globalThis.window, "undefined");
	const store = memoryStore();
	const off = store.subscribe(counter());
	off();
});

test("the default store survives a throwing window.localStorage getter", () => {
	globalThis.window = {
		get localStorage() {
			throw new Error("SecurityError");
		},
		addEventListener() {},
		removeEventListener() {},
	};
	try {
		assert.deepEqual(directoryPrefs.getSnapshot(), { pinned: [], open: {}, persistent: false });
		assert.equal(directoryPrefs.togglePin("a@w.org"), true);
		directoryPrefs.setOpen("w.org", false);
		assert.deepEqual(directoryPrefs.getSnapshot(), { pinned: ["a@w.org"], open: { "w.org": false }, persistent: false });
		assert.equal(directoryPrefs.getServerSnapshot().persistent, true);
	} finally {
		delete globalThis.window;
	}
});
