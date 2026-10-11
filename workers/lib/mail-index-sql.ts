// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * MailIndexDO SQL: a derived read model over every mailbox. Mailbox DOs stay
 * the source of truth; everything here can be rebuilt from them.
 * Pure functions over the `Exec` adapter so node:sqlite tests run this code.
 */

import { parseSearch, type Term } from "../../shared/search-query";
import { compileSearch, resolveDate, type SearchEngine, viewClause as searchViewClause } from "../store/search";
import type { IndexRow } from "./index-rows";
import type { Exec } from "./sql-exec";

/** Separates mailbox id and conversation id in `thread_key`. */
export const THREAD_KEY_SEPARATOR = "\u001f";
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY,
	mailbox_id TEXT NOT NULL,
	email_id TEXT NOT NULL,
	thread_key TEXT NOT NULL DEFAULT '',
	message_id TEXT,
	seq INTEGER NOT NULL,
	generation INTEGER NOT NULL DEFAULT 0,
	deleted INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT '',
	date TEXT NOT NULL DEFAULT '',
	sender_addr TEXT NOT NULL DEFAULT '',
	sender_name TEXT NOT NULL DEFAULT '',
	sender_domain TEXT NOT NULL DEFAULT '',
	recipients TEXT NOT NULL DEFAULT '',
	subject TEXT NOT NULL DEFAULT '',
	subject_norm TEXT NOT NULL DEFAULT '',
	snippet TEXT NOT NULL DEFAULT '',
	unread INTEGER NOT NULL DEFAULT 0,
	starred INTEGER NOT NULL DEFAULT 0,
	has_attachment INTEGER NOT NULL DEFAULT 0,
	list_id TEXT,
	unsubscribe TEXT,
	UNIQUE (mailbox_id, email_id)
);
CREATE INDEX IF NOT EXISTS messages_state_date ON messages (state, date DESC);
CREATE INDEX IF NOT EXISTS messages_sender_addr ON messages (sender_addr);
CREATE INDEX IF NOT EXISTS messages_sender_domain ON messages (sender_domain);
CREATE INDEX IF NOT EXISTS messages_mailbox ON messages (mailbox_id);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_key);
CREATE INDEX IF NOT EXISTS messages_message_id ON messages (message_id);
CREATE INDEX IF NOT EXISTS messages_tombstones ON messages (updated_at) WHERE deleted = 1;
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
	subject, sender_name, sender_addr, recipients, body_text,
	content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);
CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS message_labels (message INTEGER NOT NULL, label_id TEXT NOT NULL, PRIMARY KEY (message, label_id));
CREATE INDEX IF NOT EXISTS message_labels_label ON message_labels (label_id);
CREATE TABLE IF NOT EXISTS label_auto (label_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saved_searches (id TEXT PRIMARY KEY, name TEXT NOT NULL, filter TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS mailbox_cursor (mailbox_id TEXT PRIMARY KEY, applied_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rebuild_job (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	generation INTEGER NOT NULL,
	mailboxes TEXT NOT NULL,
	position INTEGER NOT NULL,
	after_id TEXT,
	started_at TEXT NOT NULL,
	finished_at TEXT,
	error TEXT
);
CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS undo (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bulk_job (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	action TEXT NOT NULL,
	ops TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0,
	total INTEGER NOT NULL,
	affected INTEGER NOT NULL DEFAULT 0,
	failed TEXT NOT NULL DEFAULT '[]',
	undo_id TEXT NOT NULL,
	finished_at TEXT
);
`;

export function createIndexSchema(exec: Exec): void {
	exec(INDEX_SCHEMA);
}

export function getIndexMeta(exec: Exec, key: string): string | null {
	const row = exec(`SELECT value FROM index_meta WHERE key = ?`, key)[0];
	return row ? String(row.value) : null;
}

export function setIndexMeta(exec: Exec, key: string, value: string): void {
	exec(`INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
}

export function currentGeneration(exec: Exec): number {
	return Number(getIndexMeta(exec, "generation") ?? 0);
}

export function threadKey(mailboxId: string, conversationId: string): string {
	return `${mailboxId}${THREAD_KEY_SEPARATOR}${conversationId}`;
}

// ── Apply ──────────────────────────────────────────────────────────

function deleteFts(exec: Exec, id: number): void {
	exec(`DELETE FROM messages_fts WHERE rowid = ?`, id);
}

/**
 * Apply rows pushed or exported by one mailbox. A row applies only when its
 * seq is newer than the stored one; tombstones keep their seq so an older
 * push that arrives late cannot resurrect a deleted email.
 */
export function applyRows(
	exec: Exec,
	mailboxId: string,
	rows: IndexRow[],
	options: { generation?: number; now?: number } = {},
): { applied: number; skipped: number } {
	const generation = options.generation ?? currentGeneration(exec);
	const now = options.now ?? Date.now();
	const updatedAt = new Date(now).toISOString();
	let applied = 0;
	let skipped = 0;
	let maxSeq = 0;

	for (const row of rows) {
		maxSeq = Math.max(maxSeq, row.seq);
		const existing = exec(
			`SELECT id, seq, deleted FROM messages WHERE mailbox_id = ? AND email_id = ?`,
			mailboxId,
			row.email_id,
		)[0] as { id: number; seq: number; deleted: number } | undefined;

		if (existing && existing.seq >= row.seq) {
			// Unchanged since the last apply. A rebuild still claims it for its generation.
			exec(`UPDATE messages SET generation = MAX(generation, ?) WHERE id = ?`, generation, existing.id);
			skipped++;
			continue;
		}

		if (row.deleted) {
			if (existing) {
				deleteFts(exec, existing.id);
				exec(`DELETE FROM message_labels WHERE message = ?`, existing.id);
				exec(
					`UPDATE messages SET deleted = 1, seq = ?, generation = ?, updated_at = ?, thread_key = '', state = '',
						subject = '', subject_norm = '', snippet = '', recipients = '', sender_name = '', unread = 0, starred = 0
					WHERE id = ?`,
					row.seq, generation, updatedAt, existing.id,
				);
			} else {
				exec(
					`INSERT INTO messages (mailbox_id, email_id, seq, generation, deleted, updated_at) VALUES (?, ?, ?, ?, 1, ?)`,
					mailboxId, row.email_id, row.seq, generation, updatedAt,
				);
			}
			applied++;
			continue;
		}

		const id = Number(
			exec(
				`INSERT INTO messages (
					mailbox_id, email_id, thread_key, message_id, seq, generation, deleted, updated_at, state, date,
					sender_addr, sender_name, sender_domain, recipients, subject, subject_norm, snippet,
					unread, starred, has_attachment, list_id, unsubscribe
				) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (mailbox_id, email_id) DO UPDATE SET
					thread_key = excluded.thread_key, message_id = excluded.message_id, seq = excluded.seq,
					generation = excluded.generation, deleted = 0, updated_at = excluded.updated_at,
					state = excluded.state, date = excluded.date, sender_addr = excluded.sender_addr,
					sender_name = excluded.sender_name, sender_domain = excluded.sender_domain,
					recipients = excluded.recipients, subject = excluded.subject, subject_norm = excluded.subject_norm,
					snippet = excluded.snippet, unread = excluded.unread, starred = excluded.starred,
					has_attachment = excluded.has_attachment, list_id = excluded.list_id, unsubscribe = excluded.unsubscribe
				RETURNING id`,
				mailboxId, row.email_id, threadKey(mailboxId, row.conversation_id), row.message_id, row.seq, generation,
				updatedAt, row.state, row.date, row.sender_addr, row.sender_name, row.sender_domain, row.recipients,
				row.subject, row.subject_norm, row.snippet, row.unread ? 1 : 0, row.starred ? 1 : 0,
				row.has_attachment ? 1 : 0, row.list_id, row.unsubscribe,
			)[0].id,
		);
		// FTS changes are always delete plus a full insert of every column.
		if (existing) deleteFts(exec, id);
		exec(
			`INSERT INTO messages_fts (rowid, subject, sender_name, sender_addr, recipients, body_text) VALUES (?, ?, ?, ?, ?, ?)`,
			id, row.subject, row.sender_name, row.sender_addr, row.recipients, row.body_text,
		);
		exec(`DELETE FROM message_labels WHERE message = ?`, id);
		if (row.labels.length > 0) {
			exec(
				`INSERT OR IGNORE INTO message_labels (message, label_id) SELECT ?, value FROM json_each(?)`,
				id,
				JSON.stringify(row.labels),
			);
		}
		applied++;
	}

	if (rows.length > 0) {
		exec(
			`INSERT INTO mailbox_cursor (mailbox_id, applied_seq) VALUES (?, ?)
			ON CONFLICT (mailbox_id) DO UPDATE SET applied_seq = MAX(applied_seq, excluded.applied_seq)`,
			mailboxId,
			maxSeq,
		);
	}
	exec(`DELETE FROM messages WHERE deleted = 1 AND updated_at < ?`, new Date(now - TOMBSTONE_TTL_MS).toISOString());
	return { applied, skipped };
}

function deleteRowsWhere(exec: Exec, where: string, ...params: unknown[]): number {
	exec(`DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE ${where})`, ...params);
	exec(`DELETE FROM message_labels WHERE message IN (SELECT id FROM messages WHERE ${where})`, ...params);
	const count = Number(exec(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`, ...params)[0].n);
	exec(`DELETE FROM messages WHERE ${where}`, ...params);
	return count;
}

/** Remove a mailbox from the index entirely. */
export function purgeMailbox(exec: Exec, mailboxId: string): number {
	const removed = deleteRowsWhere(exec, `mailbox_id = ?`, mailboxId);
	exec(`DELETE FROM mailbox_cursor WHERE mailbox_id = ?`, mailboxId);
	return removed;
}

/** After a rebuild pass over a mailbox, drop live rows it did not see. */
export function sweepMailbox(exec: Exec, mailboxId: string, generation: number): number {
	return deleteRowsWhere(exec, `mailbox_id = ? AND deleted = 0 AND generation < ?`, mailboxId, generation);
}

// ── Filters ────────────────────────────────────────────────────────

export const VIEWS = ["inbox", "unread", "starred", "drafts", "sent", "archive", "spam", "trash", "all", "anywhere"] as const;
export const IS_VALUES = ["unread", "read", "starred"] as const;
export const HAS_VALUES = ["attachment", "unsubscribe"] as const;
export const DATE_TOKENS = ["today", "yesterday", "7d", "30d", "older"] as const;
export const SORTS = ["date", "from", "subject", "relevance"] as const;

export interface MailFilter {
	view: string;
	address: string[];
	from: string[];
	label: string[];
	is: (typeof IS_VALUES)[number][];
	has: (typeof HAS_VALUES)[number][];
	subject: string[];
	q: string;
	date?: (typeof DATE_TOKENS)[number];
	before?: string;
	after?: string;
	sort: (typeof SORTS)[number];
	dir: "asc" | "desc";
	/** Minutes, as `Date.prototype.getTimezoneOffset()` returns; sets where "today" starts. */
	tzOffset: number;
	/** Which store runs the SQL. Set by the store; some search operators need D1's tables. */
	engine?: SearchEngine;
	/**
	 * D1 only, set by the store: words with no match in the word index, and
	 * the messages that contain them as a substring (messages_trigram).
	 */
	substrings?: Record<string, number[]>;
}

export function emptyFilter(overrides: Partial<MailFilter> = {}): MailFilter {
	return {
		view: "inbox", address: [], from: [], label: [], is: [], has: [], subject: [], q: "",
		sort: "date", dir: "desc", tzOffset: 0, ...overrides,
	};
}

export class InvalidFilterError extends Error {
	override name = "InvalidFilterError";
}

type Dimension = "view" | "address" | "from" | "label" | "status" | "date" | "text";
interface Clause {
	sql: string;
	params: unknown[];
}

function startOfLocalDay(now: number, tzOffset: number): number {
	const local = now - tzOffset * 60_000;
	return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) + tzOffset * 60_000;
}

export function dateRange(token: MailFilter["date"], now: number, tzOffset: number): { from?: string; to?: string } {
	const iso = (ms: number) => new Date(ms).toISOString();
	const today = startOfLocalDay(now, tzOffset);
	switch (token) {
		case "today": return { from: iso(today) };
		case "yesterday": return { from: iso(today - DAY_MS), to: iso(today) };
		case "7d": return { from: iso(now - 7 * DAY_MS) };
		case "30d": return { from: iso(now - 30 * DAY_MS) };
		case "older": return { to: iso(now - 30 * DAY_MS) };
		default: return {};
	}
}

function viewClause(view: string): Clause {
	const clause = searchViewClause(view);
	if (!clause) throw new InvalidFilterError(`Unknown view: ${view}`);
	return clause;
}

function addressClause(value: string): Clause {
	const v = value.trim().toLowerCase();
	if (v.startsWith("@")) return { sql: `substr(m.mailbox_id, instr(m.mailbox_id, '@') + 1) = ?`, params: [v.slice(1)] };
	if (v.includes("@")) return { sql: `m.mailbox_id = ?`, params: [v] };
	if (v.includes(".")) return { sql: `substr(m.mailbox_id, instr(m.mailbox_id, '@') + 1) = ?`, params: [v] };
	return { sql: `substr(m.mailbox_id, 1, instr(m.mailbox_id, '@') - 1) = ?`, params: [v] };
}

function fromClause(value: string): Clause {
	const v = value.trim().toLowerCase().replace(/^@/, "");
	return v.includes("@") ? { sql: `m.sender_addr = ?`, params: [v] } : { sql: `m.sender_domain = ?`, params: [v] };
}

function anyOf(clauses: Clause[]): Clause {
	return { sql: `(${clauses.map((c) => c.sql).join(" OR ")})`, params: clauses.flatMap((c) => c.params) };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A before or after chip: a calendar day starts at the reader's midnight. */
function chipDate(value: string, tzOffset: number): string {
	if (!ISO_DAY.test(value)) return value;
	const [year, month, day] = value.split("-").map(Number);
	return resolveDate({ kind: "day", year, month, day }, 0, tzOffset);
}

/**
 * The search text and subject chips, compiled. Throws on an operator that
 * doesn't parse or that this store can't run, so a search is never quietly
 * wider than what was typed.
 */
export function searchOf(filter: MailFilter, now = Date.now(), cap?: number) {
	const query = parseSearch(filter.q);
	const subjects: Term[] = filter.subject.map((value) => ({ negate: false, any: [{ type: "op", op: "subject", value, phrase: false }], start: 0, end: 0 }));
	const compiled = compileSearch({ terms: [...query.terms, ...subjects], errors: query.errors }, {
		engine: filter.engine ?? "index", now, tzOffset: filter.tzOffset, cap,
		substrings: filter.substrings ? new Map(Object.entries(filter.substrings)) : undefined,
	});
	if (compiled.errors.length > 0) throw new InvalidFilterError(compiled.errors[0]);
	return compiled;
}

function clauses(filter: MailFilter, now: number, omit?: Dimension, cap?: number): Clause[] {
	return clausesWithMatch(filter, now, omit, cap).list;
}

/** The filter's clauses, and which of them applies the words' MATCH (see CompiledSearch.match). */
function clausesWithMatch(filter: MailFilter, now: number, omit?: Dimension, cap?: number) {
	const out: Clause[] = [{ sql: `m.deleted = 0`, params: [] }];
	const search = searchOf(filter, now, cap);
	if (omit !== "view") out.push(search.scope ?? viewClause(filter.view));
	if (omit !== "address" && filter.address.length > 0) out.push(anyOf(filter.address.map(addressClause)));
	if (omit !== "from" && filter.from.length > 0) out.push(anyOf(filter.from.map(fromClause)));
	if (omit !== "label") {
		for (const label of filter.label) {
			out.push({ sql: `m.id IN (SELECT message FROM message_labels WHERE label_id = ?)`, params: [label] });
		}
	}
	if (omit !== "status") {
		for (const value of filter.is) {
			out.push({ sql: value === "unread" ? `m.unread = 1` : value === "read" ? `m.unread = 0` : `m.starred = 1`, params: [] });
		}
		for (const value of filter.has) {
			out.push({ sql: value === "attachment" ? `m.has_attachment = 1` : `m.unsubscribe IS NOT NULL`, params: [] });
		}
	}
	if (omit !== "date") {
		const range = dateRange(filter.date, now, filter.tzOffset);
		if (range.from) out.push({ sql: `m.date >= ?`, params: [range.from] });
		if (range.to) out.push({ sql: `m.date < ?`, params: [range.to] });
		if (filter.after) out.push({ sql: `m.date >= ?`, params: [chipDate(filter.after, filter.tzOffset)] });
		if (filter.before) out.push({ sql: `m.date < ?`, params: [chipDate(filter.before, filter.tzOffset)] });
	}
	out.push(...search.clauses);
	return { list: out, match: search.match, sort: parseSearch(filter.q).sort };
}

function where(list: Clause[]): Clause {
	return { sql: list.map((c) => c.sql).join(" AND "), params: list.flatMap((c) => c.params) };
}

/** WHERE clause over `messages m` for a filter, for callers outside this module (bulk targets). */
export function filterWhere(filter: MailFilter, now = Date.now(), cap?: number): { sql: string; params: unknown[] } {
	return where(clauses(filter, now, undefined, cap));
}

// ── Running a query ────────────────────────────────────────────────
//
// The list, facet and folder queries are generators that yield SQL steps and
// receive rows back. `runSync` drives them over the Durable Object's (and
// node:sqlite's) synchronous `Exec`; `runAsync` drives them over D1. One
// source for both stores.

type Row = Record<string, unknown>;
export interface SqlStep {
	sql: string;
	params: unknown[];
}
export type Query<T> = Generator<SqlStep, T, Row[]>;

export function runSync<T>(query: Query<T>, exec: Exec): T {
	let step = query.next();
	while (!step.done) step = query.next(exec(step.value.sql, ...step.value.params));
	return step.value;
}

export async function runAsync<T>(query: Query<T>, read: (sql: string, ...params: unknown[]) => Promise<Row[]>): Promise<T> {
	let step = query.next();
	while (!step.done) step = query.next(await read(step.value.sql, ...step.value.params));
	return step.value;
}

export const sqlStep = (sql: string, ...params: unknown[]): SqlStep => ({ sql, params });

// ── Conversation list ──────────────────────────────────────────────

export interface Conversation {
	thread_key: string;
	mailbox_id: string;
	email_id: string;
	message_id: string | null;
	state: string;
	date: string;
	sender_addr: string;
	sender_name: string;
	subject: string;
	snippet: string;
	unread: boolean;
	starred: boolean;
	has_attachment: boolean;
	can_unsubscribe: boolean;
	labels: string[];
	thread_count: number;
	thread_unread_count: number;
	participants: string[];
	has_draft: boolean;
	also_in: string[];
	/** With search words: how many of the conversation's messages matched. */
	match_count?: number;
	/** Set by the D1 store for rows on the page: escaped text around the matched words, with <mark>. */
	snippet_html?: string;
}

type CursorTuple = [string, string, string];

export function encodeCursor(tuple: CursorTuple): string {
	return btoa(unescape(encodeURIComponent(JSON.stringify(tuple))));
}

export function decodeCursor(cursor: string): CursorTuple {
	try {
		if (cursor.length > 4096) throw new Error();
		const tuple = JSON.parse(decodeURIComponent(escape(atob(cursor))));
		if (!Array.isArray(tuple) || tuple.length !== 3 || !tuple.every((v) => typeof v === "string")) throw new Error();
		return tuple as CursorTuple;
	} catch {
		throw new InvalidFilterError("Invalid cursor");
	}
}

const SORT_SQL: Record<Exclude<MailFilter["sort"], "relevance">, string> = {
	date: `c.latest_date`,
	from: `COALESCE(NULLIF(LOWER(m.sender_name), ''), m.sender_addr)`,
	subject: `m.subject_norm`,
};

/**
 * One page of conversations. A conversation matches when any of its messages
 * matches; the row shows the latest matching message, and the thread counts
 * cover the whole thread.
 */
export interface MailPage {
	conversations: Conversation[];
	nextCursor: string | null;
	total?: number;
	unread?: number;
	/** How the page is ordered. "relevance" only on D1, for searches with words. */
	order?: "relevance" | "date" | "from" | "subject";
	/** More than RANK_LIMIT messages matched, so the list is newest first; `sort:relevance` ranks it anyway. */
	rankSkipped?: boolean;
}

/**
 * Ranking cost grows with the number of matches: under 50 ms at 13,000 and
 * up to 0.46 s at 100,000 in phase 0. Above this the list is newest first
 * unless relevance is asked for.
 */
export const RANK_LIMIT = 20_000;

/**
 * Column weights for messages_fts (subject, sender_name, sender_addr,
 * recipients, body_text, attachment_names). Checked against
 * tests/fixtures/search-corpus.json by tests/search-ranking.test.mjs.
 */
export const BM25 = "bm25(messages_fts, 6.0, 3.0, 3.0, 2.0, 1.0, 2.0)";

/** Scores this close count as a tie, so the newer conversation goes first. */
const RANK_STEP = 0.5;

export function queryMail(
	exec: Exec,
	filter: MailFilter,
	options: { cursor?: string | null; limit?: number; now?: number } = {},
): MailPage {
	return runSync(mailQuery(filter, options), exec);
}

export function* mailQuery(
	filter: MailFilter,
	options: { cursor?: string | null; limit?: number; now?: number } = {},
): Query<MailPage> {
	const now = options.now ?? Date.now();
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
	const parts = clausesWithMatch(filter, now);
	const w = where(parts.list);
	const searching = !!filter.q.trim() || filter.subject.length > 0;

	// Relevance needs words and D1's weighted index. With words it is the
	// default for newest-first lists; `sort:date` or oldest-first keep dates.
	let order: NonNullable<MailPage["order"]> = filter.sort === "relevance" ? "date" : filter.sort;
	let rankSkipped = false;
	if (parts.match && filter.engine === "d1") {
		const asked = filter.sort === "relevance" || parts.sort === "relevance";
		const byDefault = parts.sort === undefined && filter.sort === "date" && filter.dir === "desc";
		if (asked || byDefault) {
			const [row] = yield sqlStep(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`, parts.match.expr);
			if (asked || Number(row?.n ?? 0) <= RANK_LIMIT) order = "relevance";
			else rankSkipped = true;
		}
	} else if (filter.sort === "relevance") order = "date";
	const ranked = order === "relevance" && parts.match !== null;

	const dir = ranked ? "ASC" : filter.dir === "asc" ? "ASC" : "DESC";
	const cmp = dir === "ASC" ? ">" : "<";

	const matched = `
		WITH hits AS MATERIALIZED (
			SELECT m.id, m.thread_key, m.date,
				ROW_NUMBER() OVER (PARTITION BY m.thread_key ORDER BY m.date DESC, m.id DESC) AS rn,
				COUNT(*) OVER (PARTITION BY m.thread_key) AS matches
			FROM messages m WHERE ${w.sql}
		),
		convs AS MATERIALIZED (SELECT thread_key, id AS latest_id, date AS latest_date, matches FROM hits WHERE rn = 1)`;

	// Ranked: the best-scoring message represents its conversation. The
	// index is joined in place of the MATCH clause, so there is still one MATCH.
	const rest = ranked ? where(parts.list.filter((c) => c !== parts.match!.clause)) : w;
	const rankedCte = ranked ? `
		WITH hits AS MATERIALIZED (
			SELECT m.id, m.thread_key, m.date, f.score,
				ROW_NUMBER() OVER (PARTITION BY m.thread_key ORDER BY f.score ASC, m.date DESC, m.id DESC) AS rn,
				COUNT(*) OVER (PARTITION BY m.thread_key) AS matches
			FROM (SELECT rowid AS rid, ${BM25} AS score FROM messages_fts WHERE messages_fts MATCH ?) f
			JOIN messages m ON m.id = f.rid
			WHERE ${rest.sql}
		),
		convs AS MATERIALIZED (SELECT thread_key, id AS latest_id, date AS latest_date, matches, score FROM hits WHERE rn = 1)` : "";
	const cte = ranked ? rankedCte : matched;
	const cteParams = ranked ? [parts.match!.expr, ...rest.params] : w.params;
	const sortSql = ranked ? `ROUND(c.score / ${RANK_STEP}) * ${RANK_STEP}` : SORT_SQL[order as keyof typeof SORT_SQL];

	const keyset: Clause = options.cursor
		? (() => {
			const [sv, ld, tk] = decodeCursor(options.cursor);
			const value = ranked ? Number(sv) : sv;
			if (ranked && !Number.isFinite(value)) throw new InvalidFilterError("Invalid cursor");
			return {
				sql: `AND (sort_value ${cmp} ? OR (sort_value = ? AND (latest_date < ? OR (latest_date = ? AND thread_key > ?))))`,
				params: [value, value, ld, ld, tk],
			};
		})()
		: { sql: "", params: [] };

	const page: Row[] = yield sqlStep(
		`${cte},
		sorted AS (
			SELECT c.thread_key, c.latest_id, c.latest_date, c.matches, ${sortSql} AS sort_value
			FROM convs c JOIN messages m ON m.id = c.latest_id
		)
		SELECT * FROM sorted WHERE 1 = 1 ${keyset.sql}
		ORDER BY sort_value ${dir}, latest_date DESC, thread_key ASC
		LIMIT ?`,
		...cteParams,
		...keyset.params,
		limit + 1,
	);

	const hasMore = page.length > limit;
	const pageRows = page.slice(0, limit);
	const matches = new Map(pageRows.map((r) => [Number(r.latest_id), Number(r.matches)]));
	const conversations = pageRows.length === 0 ? [] : (yield sqlStep(
		`SELECT m.*,
			(SELECT COUNT(*) FROM messages t WHERE t.thread_key = m.thread_key AND t.deleted = 0) AS thread_count,
			(SELECT COUNT(*) FROM messages t WHERE t.thread_key = m.thread_key AND t.deleted = 0 AND t.unread = 1) AS thread_unread_count,
			(SELECT GROUP_CONCAT(DISTINCT t.sender_addr) FROM messages t WHERE t.thread_key = m.thread_key AND t.deleted = 0) AS participants,
			EXISTS (SELECT 1 FROM messages t WHERE t.thread_key = m.thread_key AND t.deleted = 0 AND t.state = 'draft') AS has_draft,
			(SELECT GROUP_CONCAT(DISTINCT o.mailbox_id) FROM messages o
				WHERE m.message_id IS NOT NULL AND o.message_id = m.message_id AND o.mailbox_id != m.mailbox_id AND o.deleted = 0) AS also_in,
			(SELECT GROUP_CONCAT(label_id) FROM message_labels l WHERE l.message = m.id) AS labels
		FROM json_each(?) p
		JOIN messages m ON m.id = p.value
		ORDER BY p.key`,
		JSON.stringify(pageRows.map((r) => Number(r.latest_id))),
	)).map((row) => {
		const conversation = toConversation(row);
		return searching ? { ...conversation, match_count: matches.get(Number(row.id)) ?? 1 } : conversation;
	});

	const last = pageRows[pageRows.length - 1];
	const result: MailPage = {
		conversations,
		nextCursor: hasMore && last
			? encodeCursor([String(last.sort_value ?? ""), String(last.latest_date), String(last.thread_key)])
			: null,
		order,
		...(rankSkipped ? { rankSkipped } : {}),
	};

	if (!options.cursor) {
		const totals = (yield sqlStep(
			`${matched}
			SELECT COUNT(*) AS total,
				SUM(EXISTS (SELECT 1 FROM messages t WHERE t.thread_key = convs.thread_key AND t.deleted = 0 AND t.unread = 1)) AS unread
			FROM convs`,
			...w.params,
		))[0];
		result.total = Number(totals.total);
		result.unread = Number(totals.unread ?? 0);
	}
	return result;
}

function split(value: unknown): string[] {
	return typeof value === "string" && value ? value.split(",") : [];
}

function toConversation(row: Record<string, unknown>): Conversation {
	return {
		thread_key: String(row.thread_key),
		mailbox_id: String(row.mailbox_id),
		email_id: String(row.email_id),
		message_id: (row.message_id as string | null) ?? null,
		state: String(row.state),
		date: String(row.date),
		sender_addr: String(row.sender_addr),
		sender_name: String(row.sender_name),
		subject: String(row.subject),
		snippet: String(row.snippet),
		unread: !!row.unread,
		starred: !!row.starred,
		has_attachment: !!row.has_attachment,
		can_unsubscribe: row.unsubscribe != null,
		labels: split(row.labels).sort(),
		thread_count: Number(row.thread_count),
		thread_unread_count: Number(row.thread_unread_count),
		participants: split(row.participants),
		has_draft: !!row.has_draft,
		also_in: split(row.also_in).sort(),
	};
}

// ── Facets ─────────────────────────────────────────────────────────

export interface FacetValue {
	value: string;
	count: number;
	name?: string;
}

export interface Facets {
	address: FacetValue[];
	from: { domains: FacetValue[]; addresses: FacetValue[]; more: boolean };
	label: FacetValue[];
	date: Record<(typeof DATE_TOKENS)[number], number>;
	status: Record<"unread" | "read" | "starred" | "attachment" | "unsubscribe", number>;
}

const FROM_LIMIT = 50;

/** Every facet in one call. Each facet ignores its own dimension and counts distinct conversations. */
export function queryFacets(exec: Exec, filter: MailFilter, now = Date.now()): Facets {
	return runSync(facetsQuery(filter, now), exec);
}

/**
 * On D1, facets with search words count the newest this-many matching
 * messages: 25 to 45 ms at 100,000 matches in phase 0, against 280 ms for all.
 */
export const FACET_CAP = 5_000;

export function* facetsQuery(filter: MailFilter, now = Date.now()): Query<Facets> {
	const cap = filter.engine === "d1" ? FACET_CAP : undefined;
	const forDim = (dim: Dimension) => where(clauses(filter, now, dim, cap));

	const a = forDim("address");
	const address = (yield sqlStep(
		`SELECT m.mailbox_id AS value, COUNT(DISTINCT m.thread_key) AS count FROM messages m WHERE ${a.sql}
		GROUP BY m.mailbox_id ORDER BY count DESC, value ASC`,
		...a.params,
	)).map((r) => ({ value: String(r.value), count: Number(r.count) }));

	const f = forDim("from");
	const domains = (yield sqlStep(
		`SELECT m.sender_domain AS value, COUNT(DISTINCT m.thread_key) AS count FROM messages m
		WHERE ${f.sql} AND m.sender_domain != '' GROUP BY m.sender_domain ORDER BY count DESC, value ASC LIMIT ?`,
		...f.params, FROM_LIMIT + 1,
	)).map((r) => ({ value: String(r.value), count: Number(r.count) }));
	const addresses = (yield sqlStep(
		`SELECT m.sender_addr AS value, MAX(m.sender_name) AS name, COUNT(DISTINCT m.thread_key) AS count FROM messages m
		WHERE ${f.sql} AND m.sender_addr != '' GROUP BY m.sender_addr ORDER BY count DESC, value ASC LIMIT ?`,
		...f.params, FROM_LIMIT + 1,
	)).map((r) => ({ value: String(r.value), name: String(r.name ?? ""), count: Number(r.count) }));

	const l = forDim("label");
	const label = (yield sqlStep(
		`SELECT lb.id AS value, lb.name AS name, COUNT(DISTINCT m.thread_key) AS count
		FROM labels lb
		LEFT JOIN message_labels ml ON ml.label_id = lb.id
		LEFT JOIN messages m ON m.id = ml.message AND ${l.sql}
		GROUP BY lb.id ORDER BY lb.position, lb.name`,
		...l.params,
	)).map((r) => ({ value: String(r.value), name: String(r.name), count: Number(r.count) }));

	const d = forDim("date");
	const ranges = DATE_TOKENS.map((token) => dateRange(token, now, filter.tzOffset));
	const dateRow = (yield sqlStep(
		`SELECT ${ranges.map((r, i) =>
			`COUNT(DISTINCT CASE WHEN ${r.from ? "m.date >= ?" : "1"} AND ${r.to ? "m.date < ?" : "1"} THEN m.thread_key END) AS d${i}`,
		).join(", ")} FROM messages m WHERE ${d.sql}`,
		...ranges.flatMap((r) => [r.from, r.to].filter(Boolean)),
		...d.params,
	))[0];
	const date = Object.fromEntries(DATE_TOKENS.map((token, i) => [token, Number(dateRow[`d${i}`])])) as Facets["date"];

	const s = forDim("status");
	const statusRow = (yield sqlStep(
		`SELECT
			COUNT(DISTINCT CASE WHEN m.unread = 1 THEN m.thread_key END) AS unread,
			COUNT(DISTINCT CASE WHEN m.unread = 0 THEN m.thread_key END) AS read,
			COUNT(DISTINCT CASE WHEN m.starred = 1 THEN m.thread_key END) AS starred,
			COUNT(DISTINCT CASE WHEN m.has_attachment = 1 THEN m.thread_key END) AS attachment,
			COUNT(DISTINCT CASE WHEN m.unsubscribe IS NOT NULL THEN m.thread_key END) AS unsubscribe
		FROM messages m WHERE ${s.sql}`,
		...s.params,
	))[0];
	const status = Object.fromEntries(
		["unread", "read", "starred", "attachment", "unsubscribe"].map((k) => [k, Number(statusRow[k])]),
	) as Facets["status"];

	return {
		address,
		from: {
			domains: domains.slice(0, FROM_LIMIT),
			addresses: addresses.slice(0, FROM_LIMIT),
			more: domains.length > FROM_LIMIT || addresses.length > FROM_LIMIT,
		},
		label,
		date,
		status,
	};
}

// ── Status ─────────────────────────────────────────────────────────

/** Per-mailbox message counts for the parity page; same shape as `mailboxCounts`. */
export function indexCounts(exec: Exec) {
	const out: Record<string, { states: Record<string, number>; unread: number; starred: number; total: number; inboxConversations: number; appliedSeq: number }> = {};
	const entry = (id: string) =>
		(out[id] ??= { states: {}, unread: 0, starred: 0, total: 0, inboxConversations: 0, appliedSeq: 0 });
	for (const row of exec(
		`SELECT mailbox_id, state, COUNT(*) AS n,
			SUM(CASE WHEN unread = 1 AND state = 'inbox' THEN 1 ELSE 0 END) AS unread,
			SUM(starred) AS starred
		FROM messages WHERE deleted = 0 GROUP BY mailbox_id, state`,
	)) {
		const e = entry(String(row.mailbox_id));
		e.states[String(row.state)] = Number(row.n);
		e.unread += Number(row.unread);
		e.starred += Number(row.starred);
		e.total += Number(row.n);
	}
	for (const row of exec(
		`SELECT mailbox_id, COUNT(DISTINCT thread_key) AS n FROM messages WHERE deleted = 0 AND state = 'inbox' GROUP BY mailbox_id`,
	)) entry(String(row.mailbox_id)).inboxConversations = Number(row.n);
	for (const row of exec(`SELECT mailbox_id, applied_seq FROM mailbox_cursor`)) {
		entry(String(row.mailbox_id)).appliedSeq = Number(row.applied_seq);
	}
	return out;
}

/** Custom folder views (`folder:<id>`) with conversation counts, for the source list. */
export function folderViews(exec: Exec): { view: string; count: number }[] {
	return runSync(folderViewsQuery(), exec);
}

export function* folderViewsQuery(): Query<{ view: string; count: number }[]> {
	return (yield sqlStep(
		`SELECT state AS view, COUNT(DISTINCT thread_key) AS count FROM messages
		WHERE deleted = 0 AND state LIKE 'folder:%' GROUP BY state ORDER BY state`,
	)).map((r) => ({ view: String(r.view), count: Number(r.count) }));
}

export function messageCount(exec: Exec): number {
	return Number(exec(`SELECT COUNT(*) AS n FROM messages WHERE deleted = 0`)[0].n);
}

// ── Rebuild job ────────────────────────────────────────────────────

export interface RebuildJob {
	generation: number;
	mailboxes: string[];
	position: number;
	afterId: string | null;
	startedAt: string;
	finishedAt: string | null;
	error: string | null;
}

export function getRebuildJob(exec: Exec): RebuildJob | null {
	const row = exec(`SELECT * FROM rebuild_job WHERE id = 1`)[0];
	if (!row) return null;
	return {
		generation: Number(row.generation),
		mailboxes: JSON.parse(String(row.mailboxes)),
		position: Number(row.position),
		afterId: (row.after_id as string | null) ?? null,
		startedAt: String(row.started_at),
		finishedAt: (row.finished_at as string | null) ?? null,
		error: (row.error as string | null) ?? null,
	};
}

/** Start a rebuild over these mailboxes with a new generation. Replaces any running job. */
export function startRebuildJob(exec: Exec, mailboxes: string[], now = Date.now()): RebuildJob {
	const generation = currentGeneration(exec) + 1;
	setIndexMeta(exec, "generation", String(generation));
	exec(
		`INSERT INTO rebuild_job (id, generation, mailboxes, position, after_id, started_at, finished_at, error)
		VALUES (1, ?, ?, 0, NULL, ?, NULL, NULL)
		ON CONFLICT (id) DO UPDATE SET generation = excluded.generation, mailboxes = excluded.mailboxes,
			position = 0, after_id = NULL, started_at = excluded.started_at, finished_at = NULL, error = NULL`,
		generation,
		JSON.stringify(mailboxes),
		new Date(now).toISOString(),
	);
	return getRebuildJob(exec)!;
}

export function saveRebuildProgress(
	exec: Exec,
	progress: { position: number; afterId: string | null; finishedAt?: string | null; error?: string | null },
): void {
	exec(
		`UPDATE rebuild_job SET position = ?, after_id = ?, finished_at = ?, error = ? WHERE id = 1`,
		progress.position,
		progress.afterId,
		progress.finishedAt ?? null,
		progress.error ?? null,
	);
}
