// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Where the cursor is in a search, and whether the text reads like a request.
 * The search window and the suggest API both use these.
 */
import { OPERATORS, type Operator, parseSearch } from "./search-query";

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
