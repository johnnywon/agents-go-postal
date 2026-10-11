// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The search window's logic, kept free of React so it can be tested:
 * what the cursor is completing, the completions for it, recent searches,
 * plain-words detection and the key map.
 */
import {
	HAS_SEARCH_VALUES,
	IN_VALUES,
	IS_SEARCH_VALUES,
	OPERATOR_HELP,
	OPERATORS,
	type Operator,
	parseSearch,
	SORT_VALUES,
} from "../../../shared/search-query";

/** A whitespace-separated span of the search text. A quote keeps spaces inside it, to its close or the end. */
export interface Span {
	start: number;
	end: number;
	text: string;
}

export function spans(text: string): Span[] {
	const out: Span[] = [];
	let i = 0;
	while (i < text.length) {
		if (/\s/.test(text[i])) {
			i++;
			continue;
		}
		const start = i;
		let quoted = false;
		while (i < text.length && (quoted || !/\s/.test(text[i]))) {
			if (text[i] === '"') quoted = !quoted;
			i++;
		}
		out.push({ start, end: i, text: text.slice(start, i) });
	}
	return out;
}

export type CompletionContext =
	| { kind: "value"; op: Operator; partial: string; start: number; end: number; negate: boolean; term: string }
	| { kind: "operator"; start: number; end: number; negate: boolean };

const OPERATOR_SET: ReadonlySet<string> = new Set(OPERATORS);

/** What the cursor is completing: an operator's value (`from:st|`), or an operator (`xyz:|`). */
export function completionAt(text: string, cursor: number): CompletionContext | null {
	const span = spans(text).find((s) => s.start <= cursor && cursor <= s.end);
	if (!span) return null;
	const negate = span.text.startsWith("-");
	const m = (negate ? span.text.slice(1) : span.text).match(/^([a-z]+):(.*)$/i);
	if (!m) return null;
	const op = m[1].toLowerCase();
	if (OPERATOR_SET.has(op)) {
		const partial = m[2].replace(/^"|"$/g, "").toLowerCase();
		return { kind: "value", op: op as Operator, partial, start: span.start, end: span.end, negate, term: span.text };
	}
	return m[2] === "" ? { kind: "operator", start: span.start, end: span.end, negate } : null;
}

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
	/** Senders and sender domains with message counts. */
	senders: readonly { value: string; name?: string; count: number }[];
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
		case "from":
		case "cc":
			return withDash(
				[...data.senders]
					.filter((s) => prefixOf(s.value, partial) || (!!s.name && prefixOf(s.name, partial)))
					.sort((a, b) => b.count - a.count)
					.map((s) => ({ label: s.value, detail: s.name, count: s.count, insert: `${op}:${quoteValue(s.value)}` })),
			);
		case "to":
			return withDash(data.addresses.filter((a) => prefixOf(a, partial)).map((a) => ({ label: a, insert: `to:${a}` })));
		case "label":
			return withDash(
				data.labels
					.filter((l) => prefixOf(l.name, partial))
					.map((l) => ({ label: l.name, count: l.count, insert: `label:${quoteValue(l.name)}` })),
			);
		case "in": return withDash(fixed("in", IN_VALUES, partial));
		case "is": return withDash(fixed("is", IS_SEARCH_VALUES, partial));
		// has:link waits for the D1 search engine (S4).
		case "has": return withDash(fixed("has", HAS_SEARCH_VALUES.filter((v) => v !== "link"), partial));
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

/** Remove the term covering [start, end) and tidy the spaces. */
export function removeRange(text: string, start: number, end: number): string {
	return `${text.slice(0, start)} ${text.slice(end)}`.replace(/\s+/g, " ").trim();
}

/** Filter terms of the search (not words), each with its place in the text, for "Remove …". */
export function filterTerms(text: string): { text: string; start: number; end: number }[] {
	return parseSearch(text)
		.terms.filter((t) => t.any.every((l) => l.type !== "word" && l.type !== "phrase"))
		.map((t) => ({ text: text.slice(t.start, t.end), start: t.start, end: t.end }));
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

// ── Plain-words requests ───────────────────────────────────────────

const REQUEST_START = new Set(["find", "show", "where", "emails", "which", "what", "who", "when"]);

/** Text that reads like a request for the agent: four or more plain words, or a request word first. */
export function looksLikeRequest(text: string): boolean {
	const query = parseSearch(text);
	const leaves = query.terms.flatMap((t) => t.any);
	if (leaves.length === 0 || query.terms.some((t) => t.negate) || leaves.some((l) => l.type !== "word")) return false;
	const first = leaves[0].type === "word" ? leaves[0].text.toLowerCase() : "";
	return leaves.length >= 4 || (REQUEST_START.has(first) && leaves.length >= 2);
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
	| { type: "reopen" };

/** What a key does in the search box. Null leaves it to the input. */
export function windowKey(e: KeyInput, s: WindowState): WindowAction | null {
	const mod = !!(e.meta || e.ctrl);
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
