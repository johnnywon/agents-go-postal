// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Compiles a SearchQuery (shared/search-query.ts) to WHERE clauses over
 * `messages m`. The same SQL runs on the combined index (MailIndexDO) and on
 * D1, whose tables share the column names. A few operators need tables only
 * D1 has; on the index they are an error.
 *
 * Every word, phrase and text operator goes into one FTS5 expression, so a
 * statement never holds more than one MATCH. Phase 0 found that two MATCHes
 * on the same table in one statement can exhaust D1's CPU limit and reset
 * the database; tests/search-compile.test.mjs checks every statement.
 */
import { type DateValue, IN_VALUES, type Leaf, type SearchQuery, type Term } from "../../shared/search-query";

export type SearchEngine = "index" | "d1";

export interface Clause {
	sql: string;
	params: unknown[];
}

export interface CompiledSearch {
	/** ANDed with the filter's other clauses. */
	clauses: Clause[];
	/** Set when the query names where to look (`in:`); replaces the view. */
	scope: Clause | null;
	errors: string[];
}

const DAY_MS = 86_400_000;
const WORD = /[\p{L}\p{N}]/u;
const FOLDER_ID = /^folder:[\w-]+$/;

/** The view's state condition. `anywhere` is every folder, spam and trash included. */
export function viewClause(view: string): Clause | null {
	switch (view) {
		case "inbox": return { sql: `m.state = 'inbox'`, params: [] };
		case "unread": return { sql: `m.state = 'inbox' AND m.unread = 1`, params: [] };
		case "starred": return { sql: `m.starred = 1 AND m.state NOT IN ('trash', 'spam')`, params: [] };
		case "drafts": return { sql: `m.state = 'draft'`, params: [] };
		case "sent": case "archive": case "spam": case "trash": return { sql: `m.state = ?`, params: [view] };
		case "all": return { sql: `m.state NOT IN ('trash', 'spam')`, params: [] };
		case "anywhere": return { sql: `1 = 1`, params: [] };
		default: return FOLDER_ID.test(view) ? { sql: `m.state = ?`, params: [view] } : null;
	}
}

/** A quoted FTS5 phrase. Inside quotes FTS5 only tokenizes, so user text is never query syntax. */
const phrase = (text: string, prefix: boolean) => `"${text.replace(/"/g, '""')}"${prefix ? "*" : ""}`;

/** Each word as a prefix phrase, ANDed, in the given columns (all when empty). */
function words(text: string, columns: string): string | null {
	const parts = text.split(/\s+/).filter((t) => WORD.test(t)).map((t) => `${columns}${phrase(t, true)}`);
	if (parts.length === 0) return null;
	return parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;
}

function textLeaf(text: string, isPhrase: boolean, columns: string): string | null {
	if (!WORD.test(text)) return null;
	return isPhrase ? `${columns}${phrase(text, false)}` : words(text, columns);
}

/** `from:`, `to:`: an address or domain is a phrase in the address column; a name is a prefix over name and address. */
function personLeaf(value: string, isPhrase: boolean, nameColumns: string, addressColumn: string): string | null {
	const v = value.replace(/^@/, "");
	if (!isPhrase && (v.includes("@") || v.includes("."))) return textLeaf(v, true, `${addressColumn} : `);
	return isPhrase ? textLeaf(v, true, `${nameColumns} : `) : textLeaf(v, false, `${nameColumns} : `);
}

export function resolveDate(value: DateValue, now: number, tzOffset: number): string {
	switch (value.kind) {
		case "instant": return value.iso;
		case "day": return new Date(Date.UTC(value.year, value.month - 1, value.day) + tzOffset * 60_000).toISOString();
		case "ago": {
			const d = new Date(now);
			if (value.unit === "d") return new Date(now - value.amount * DAY_MS).toISOString();
			if (value.unit === "w") return new Date(now - value.amount * 7 * DAY_MS).toISOString();
			if (value.unit === "m") d.setUTCMonth(d.getUTCMonth() - value.amount);
			else d.setUTCFullYear(d.getUTCFullYear() - value.amount);
			return d.toISOString();
		}
	}
}

type Compiled = { fts: string } | { sql: Clause } | { error: string } | null;

const D1_ONLY = "works once mail is stored in D1";

function compileLeaf(leaf: Leaf, engine: SearchEngine, now: number, tzOffset: number): Compiled {
	const fts = (expr: string | null): Compiled => (expr ? { fts: expr } : null);
	const sql = (text: string, ...params: unknown[]): Compiled => ({ sql: { sql: text, params } });
	const d1 = (label: string, build: () => Compiled): Compiled => (engine === "d1" ? build() : { error: `${label} ${D1_ONLY}` });
	switch (leaf.type) {
		case "word": return fts(textLeaf(leaf.text, false, ""));
		case "phrase": return fts(textLeaf(leaf.text, true, ""));
		case "date": return sql(`m.date ${leaf.op === "before" ? "<" : ">="} ?`, resolveDate(leaf.value, now, tzOffset));
		case "size": return d1(`${leaf.op}:`, () => sql(`m.size ${leaf.op === "larger" ? ">" : "<"} ?`, leaf.bytes));
	}
	const { value } = leaf;
	switch (leaf.op) {
		case "subject": return fts(textLeaf(value, leaf.phrase, "subject : "));
		case "from": return fts(personLeaf(value, leaf.phrase, "{sender_name sender_addr}", "sender_addr"));
		case "to": return fts(personLeaf(value, leaf.phrase, "recipients", "recipients"));
		case "filename": return d1("filename:", () => fts(textLeaf(value, leaf.phrase, "attachment_names : ")));
		case "cc": return d1("cc:", () => sql(`instr(lower(COALESCE(m.cc, '')), ?) > 0`, value.replace(/^@/, "")));
		case "list": return sql(`instr(lower(COALESCE(m.list_id, '')), ?) > 0`, value);
		case "label": {
			const v = value.toLowerCase();
			return sql(`m.id IN (SELECT ml.message FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE l.id = ? OR lower(l.name) = ?)`, v, v);
		}
		case "in": {
			const view = value === "draft" ? "drafts" : value;
			if ((IN_VALUES as readonly string[]).includes(view)) return { sql: viewClause(view)! };
			if (engine === "index") return sql(`m.state = ?`, `folder:${value}`);
			return sql(
				`m.state IN (SELECT 'folder:' || f.id FROM folders f WHERE f.mailbox_id = m.mailbox_id AND (f.id = ? OR lower(f.name) = ?))`,
				value, value,
			);
		}
		case "is":
			switch (value) {
				case "unread": return sql(`m.unread = 1`);
				case "read": return sql(`m.unread = 0`);
				case "starred": return sql(`m.starred = 1`);
				case "scheduled": return d1("is:scheduled", () => sql(`m.email_id IN (SELECT email_id FROM scheduled_sends)`));
				case "replied":
					// A later message sent in the same conversation.
					return sql(`m.state != 'sent' AND EXISTS (SELECT 1 FROM messages r WHERE r.thread_key = m.thread_key AND r.state = 'sent' AND r.deleted = 0 AND r.date > m.date)`);
			}
			break;
		case "has":
			switch (value) {
				case "attachment": return sql(`m.has_attachment = 1`);
				case "unsubscribe": return sql(`m.unsubscribe IS NOT NULL`);
				case "draft": return sql(`EXISTS (SELECT 1 FROM messages d WHERE d.thread_key = m.thread_key AND d.state = 'draft' AND d.deleted = 0)`);
				case "pdf":
					return d1("has:pdf", () => sql(`EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = m.email_id AND (a.mimetype = 'application/pdf' OR lower(a.filename) LIKE '%.pdf'))`));
				case "image":
					return d1("has:image", () => sql(`EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = m.email_id AND a.mimetype LIKE 'image/%' AND COALESCE(a.disposition, 'attachment') != 'inline')`));
				case "link":
					// Needs a column set when mail is stored; comes with the D1 search engine (S4).
					return { error: "has:link isn't searchable yet" };
			}
			break;
	}
	return { error: `${leaf.op}:${value} isn't supported` };
}

const or = (list: string[]) => (list.length === 1 ? list[0] : `(${list.join(" OR ")})`);

export interface CompileOptions {
	engine: SearchEngine;
	now: number;
	tzOffset: number;
}

/**
 * WHERE clauses for a query. Parse errors are reported with compile errors;
 * a caller that runs the SQL refuses the query when there are any.
 */
export function compileSearch(query: Pick<SearchQuery, "terms" | "errors">, options: CompileOptions): CompiledSearch {
	const errors = query.errors.map((e) => e.message);
	const clauses: Clause[] = [];
	const scopes: Clause[] = [];
	const include: string[] = [];
	const exclude: string[] = [];

	for (const term of query.terms) {
		const parts = term.any.map((leaf) => compileLeaf(leaf, options.engine, options.now, options.tzOffset));
		const failed = parts.find((p): p is { error: string } => !!p && "error" in p);
		if (failed) {
			errors.push(failed.error);
			continue;
		}
		const ftsParts = parts.flatMap((p) => (p && "fts" in p ? [p.fts] : []));
		const sqlParts = parts.flatMap((p) => (p && "sql" in p ? [p.sql] : []));
		if (ftsParts.length > 0 && sqlParts.length > 0) {
			// parseSearch already refuses these; this guards hand-built queries.
			errors.push("OR can't join words with filters like is:, label: or dates");
			continue;
		}
		if (ftsParts.length > 0) {
			(term.negate ? exclude : include).push(or(ftsParts));
			continue;
		}
		if (sqlParts.length === 0) continue;
		const joined: Clause = sqlParts.length === 1
			? sqlParts[0]
			: { sql: `(${sqlParts.map((c) => c.sql).join(" OR ")})`, params: sqlParts.flatMap((c) => c.params) };
		if (term.negate) clauses.push({ sql: `NOT (${joined.sql})`, params: joined.params });
		else if (isScope(term)) scopes.push(joined);
		else clauses.push(joined);
	}

	if (include.length > 0) {
		const match = exclude.length > 0 ? `(${include.join(" AND ")}) NOT ${or(exclude)}` : include.join(" AND ");
		clauses.push({ sql: `m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`, params: [match] });
	} else if (exclude.length > 0) {
		clauses.push({ sql: `m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`, params: [exclude.join(" OR ")] });
	}
	const scope = scopes.length === 0
		? null
		: { sql: scopes.map((c) => `(${c.sql})`).join(" AND "), params: scopes.flatMap((c) => c.params) };
	return { clauses, scope, errors };
}

function isScope(term: Term): boolean {
	return term.any.every((leaf) => leaf.type === "op" && leaf.op === "in");
}
