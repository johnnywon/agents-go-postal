// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The search window's logic, kept free of React so it can be tested:
 * what the cursor is completing, the completions for it, recent searches,
 * plain-words detection and the key map.
 */
import { type CompletionContext } from "../../../shared/search-complete";
import { HAS_SEARCH_VALUES, IN_VALUES, IS_SEARCH_VALUES, OPERATOR_HELP, OPERATORS, parseSearch, SORT_VALUES } from "../../../shared/search-query";

export { completionAt, type CompletionContext, filterTerms, looksLikeRequest, removeRange, spans } from "../../../shared/search-complete";

export interface Completion {
	/** The text shown. */
	label: string;
	detail?: string;
	count?: number;
	/** The whole term written in place of the one at the cursor. Ends with `:` when a value comes next. */
	insert: string;
}

export interface CompletionData {
	/** The deployment's own addresses. */
	addresses: readonly string[];
	/** Senders and sender domains with conversation counts. */
	senders: readonly { value: string; name?: string; count: number }[];
	/** Addresses you've written to or that were copied, with counts. */
	recipients?: readonly { value: string; count: number }[];
	labels: readonly { name: string; count: number }[];
	now: Date;
}

const MAX_COMPLETIONS = 8;

export const quoteValue = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, "")}"` : value);

const pad = (n: number) => String(n).padStart(2, "0");
/** The reader's local calendar day. */
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function dateValues(now: Date): { label: string; value: string }[] {
	const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
	return [
		{ label: "Today", value: localDay(day(0)) },
		{ label: "Yesterday", value: localDay(day(-1)) },
		{ label: "7 days ago", value: "7d" },
		{ label: "Start of this month", value: localDay(new Date(now.getFullYear(), now.getMonth(), 1)) },
		{ label: "Start of last month", value: localDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)) },
	];
}

const fixed = (op: string, values: readonly string[], partial: string): Completion[] =>
	values.filter((v) => v.startsWith(partial)).map((v) => ({ label: v, insert: `${op}:${v}` }));

/** A value matches a prefix at its start or after `@`, `.` or a space. */
const prefixOf = (value: string, partial: string) => !partial || new RegExp(`(?:^|[@.\\s])${partial.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(value.toLowerCase());

/** Your addresses first, then the people you've written to. For `to:` and `cc:`. */
function recipientList(op: "to" | "cc", data: CompletionData, partial: string): Completion[] {
	const own = data.addresses.filter((a) => prefixOf(a, partial));
	const mine = new Set(own.map((a) => a.toLowerCase()));
	const others = (data.recipients ?? []).filter((r) => !mine.has(r.value.toLowerCase()) && prefixOf(r.value, partial));
	return [
		...own.map((a) => ({ label: a, detail: "your address", insert: `${op}:${a}` })),
		...others.map((r) => ({ label: r.value, count: r.count, insert: `${op}:${r.value}` })),
	];
}

export function completions(ctx: CompletionContext, data: CompletionData): Completion[] {
	const dash = ctx.negate ? "-" : "";
	// A value already written in full isn't offered again.
	const withDash = (list: Completion[]) =>
		list
			.map((c) => ({ ...c, insert: dash + c.insert }))
			.filter((c) => ctx.kind === "operator" || c.insert.toLowerCase() !== ctx.term.toLowerCase())
			.slice(0, MAX_COMPLETIONS);
	if (ctx.kind === "operator") {
		return OPERATORS.map((op) => ({ label: `${op}:`, detail: OPERATOR_HELP[op], insert: `${dash}${op}:` }));
	}
	const { op, partial } = ctx;
	switch (op) {
		case "cc":
			return withDash(recipientList("cc", data, partial));
		case "from":
			return withDash(
				[...data.senders]
					.filter((s) => prefixOf(s.value, partial) || (!!s.name && prefixOf(s.name, partial)))
					.sort((a, b) => b.count - a.count)
					.map((s) => ({ label: s.value, detail: s.name, count: s.count, insert: `${op}:${quoteValue(s.value)}` })),
			);
		case "to":
			return withDash(recipientList("to", data, partial));
		case "label":
			return withDash(
				data.labels
					.filter((l) => prefixOf(l.name, partial))
					.map((l) => ({ label: l.name, count: l.count, insert: `label:${quoteValue(l.name)}` })),
			);
		case "in": return withDash(fixed("in", IN_VALUES, partial));
		case "is": return withDash(fixed("is", IS_SEARCH_VALUES, partial));
		case "has": return withDash(fixed("has", HAS_SEARCH_VALUES, partial));
		case "sort": return withDash(fixed("sort", SORT_VALUES, partial));
		case "before":
		case "after":
			return withDash(
				dateValues(data.now)
					.filter((d) => !partial || d.value.startsWith(partial) || d.label.toLowerCase().startsWith(partial))
					.map((d) => ({ label: d.label, detail: d.value, insert: `${op}:${d.value}` })),
			);
		case "newer":
		case "older": return withDash(fixed(op, ["7d", "30d", "3m", "1y"], partial));
		case "larger":
		case "smaller": return withDash(fixed(op, ["100k", "1mb", "5mb", "10mb"], partial));
		default: return [];
	}
}

/** Write a completion over the term at the cursor. A finished value gets a trailing space. */
export function applyCompletion(text: string, ctx: CompletionContext, insert: string): { text: string; cursor: number } {
	const before = text.slice(0, ctx.start);
	const after = text.slice(ctx.end);
	const open = insert.endsWith(":");
	const space = open || after.startsWith(" ") ? "" : " ";
	const cursor = before.length + insert.length + (open ? 0 : 1);
	return { text: before + insert + space + after, cursor };
}

/** Add a term to the end of the search. */
export function appendTerm(text: string, term: string): string {
	return `${`${text.trim()} ${term}`.trim()} `;
}

/**
 * Server snippet HTML, if `<mark>` is its only markup; otherwise null and the
 * caller shows plain text. The server escapes mail text; this checks again.
 */
export function snippetMarkup(html: string | undefined): string | null {
	if (!html) return null;
	return /[<>]/.test(html.replace(/<\/?mark>/g, "")) ? null : html;
}

/** Search text with any `sort:` term replaced: `relevance` drops it, as ranking is the default with words. */
export function withOrder(search: string, order: "relevance" | "date", force = false): string {
	const rest = search.replace(/(^|\s)-?sort:\S*/gi, " ").replace(/\s+/g, " ").trim();
	const term = order === "date" ? "sort:date" : force ? "sort:relevance" : "";
	return (term ? `${rest} ${term} ` : `${rest} `).trimStart();
}

/** Text split into pieces, with every word that starts with a search term marked, as the server's snippets mark them. */
export function marks(text: string, terms: readonly string[]): { text: string; mark: boolean }[] {
	const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	const folded = terms.map(fold).filter(Boolean);
	if (folded.length === 0) return [{ text, mark: false }];
	const out: { text: string; mark: boolean }[] = [];
	let at = 0;
	for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
		const word = fold(m[0]);
		if (!folded.some((t) => word.startsWith(t))) continue;
		if (m.index! > at) out.push({ text: text.slice(at, m.index), mark: false });
		out.push({ text: m[0], mark: true });
		at = m.index! + m[0].length;
	}
	if (at < text.length) out.push({ text: text.slice(at), mark: false });
	return out;
}

// ── Recent searches ────────────────────────────────────────────────

export const RECENT_KEY = "pg-recent-searches";
export const MAX_RECENT = 8;

export function addRecent(list: readonly string[], search: string): string[] {
	const q = search.replace(/\s+/g, " ").trim();
	if (!q) return [...list];
	return [q, ...list.filter((s) => s !== q)].slice(0, MAX_RECENT);
}

/** Recent searches from browser storage. Empty when storage is blocked or holds something else. */
export function loadRecent(storage: Pick<Storage, "getItem"> | undefined): string[] {
	try {
		const value = JSON.parse(storage?.getItem(RECENT_KEY) ?? "[]");
		return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string").slice(0, MAX_RECENT) : [];
	} catch {
		return [];
	}
}

export function saveRecent(storage: Pick<Storage, "setItem"> | undefined, list: readonly string[]): void {
	try {
		storage?.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
	} catch {
		// Storage is full or blocked; recent searches last for this page only.
	}
}

// ── Keys ───────────────────────────────────────────────────────────

export interface KeyInput {
	key: string;
	meta?: boolean;
	ctrl?: boolean;
	shift?: boolean;
}

export interface WindowState {
	open: boolean;
	/** The highlighted row, or -1. */
	active: number;
	rows: number;
	/** Whether the window lists completions for the term at the cursor. */
	completing: boolean;
	hasText: boolean;
}

export type WindowAction =
	| { type: "close" }
	| { type: "clear" }
	| { type: "blur" }
	| { type: "highlight"; active: number }
	| { type: "list"; delta: number }
	| { type: "complete" }
	| { type: "choose" }
	| { type: "openFirst" }
	| { type: "run" }
	| { type: "reopen" }
	| { type: "save" };

/** What a key does in the search box. Null leaves it to the input. */
export function windowKey(e: KeyInput, s: WindowState): WindowAction | null {
	const mod = !!(e.meta || e.ctrl);
	if (mod && e.key.toLowerCase() === "s") return s.hasText ? { type: "save" } : null;
	switch (e.key) {
		case "Escape":
			if (s.open) return { type: "close" };
			return s.hasText ? { type: "clear" } : { type: "blur" };
		case "ArrowDown":
		case "ArrowUp": {
			const delta = e.key === "ArrowDown" ? 1 : -1;
			if (!s.open) return s.hasText ? { type: "list", delta } : { type: "reopen" };
			if (s.rows === 0) return null;
			// -1 sits between the last row and the first.
			const next = s.active + delta;
			return { type: "highlight", active: next < -1 ? s.rows - 1 : next >= s.rows ? -1 : next };
		}
		case "Tab":
			return s.open && s.completing && !e.shift ? { type: "complete" } : null;
		case "Enter":
			if (mod) return { type: "run" };
			return s.open && s.active >= 0 ? { type: "choose" } : { type: "openFirst" };
		default:
			return null;
	}
}
