// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Checked rows in the conversation list, by thread key. `allMatching` means
 * "every conversation the filter matches", including rows not loaded yet.
 */
export interface Selection {
	keys: ReadonlySet<string>;
	anchor: string | null;
	allMatching: boolean;
}

export const EMPTY_SELECTION: Selection = { keys: new Set(), anchor: null, allMatching: false };

export function clear(): Selection {
	return EMPTY_SELECTION;
}

export function toggle(sel: Selection, key: string): Selection {
	const keys = new Set(sel.keys);
	if (keys.has(key)) keys.delete(key);
	else keys.add(key);
	return { keys, anchor: key, allMatching: false };
}

/** Shift-click: check every row from the anchor to this one. Without an anchor it toggles. */
export function range(sel: Selection, key: string, ordered: readonly string[]): Selection {
	const from = sel.anchor ? ordered.indexOf(sel.anchor) : -1;
	const to = ordered.indexOf(key);
	if (from < 0 || to < 0) return toggle(sel, key);
	const keys = new Set(sel.keys);
	for (let i = Math.min(from, to); i <= Math.max(from, to); i++) keys.add(ordered[i]);
	return { keys, anchor: key, allMatching: false };
}

export function selectAll(sel: Selection, ordered: readonly string[]): Selection {
	return { keys: new Set(ordered), anchor: sel.anchor, allMatching: false };
}

export function selectAllMatching(sel: Selection): Selection {
	return { ...sel, allMatching: true };
}

/** Drop checked rows that are no longer in the list. */
export function prune(sel: Selection, present: readonly string[]): Selection {
	const set = new Set(present);
	const keys = [...sel.keys].filter((k) => set.has(k));
	return keys.length === sel.keys.size ? sel : { ...sel, keys: new Set(keys) };
}

export function count(sel: Selection, total: number): number {
	return sel.allMatching ? total : sel.keys.size;
}
