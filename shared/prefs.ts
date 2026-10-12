// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { cleanOverrides, sameOverrides, type ShortcutOverrides } from "./shortcuts";

/** Settings > General. Saved to the deployment (R2 config/prefs.json); each browser keeps a copy for a fast first paint. */
export interface Prefs {
	theme: "dark" | "light" | "system";
	/** Show key hints next to controls. Shortcuts work either way. */
	keys: boolean;
	markRead: boolean;
	images: "ask" | "always" | "never";
	replyFrom: boolean;
	/** Rebound keyboard shortcuts; anything not here keeps its default keys. */
	shortcuts: ShortcutOverrides;
}

export const DEFAULT_PREFS: Prefs = { theme: "dark", keys: true, markRead: true, images: "ask", replyFrom: true, shortcuts: {} };

const THEMES = ["dark", "light", "system"] as const;
const IMAGES = ["ask", "always", "never"] as const;

/** Prefs from untrusted input: each known field is kept only if valid, otherwise it comes from base. Unknown fields are dropped. */
export function cleanPrefs(input: unknown, base: Prefs = DEFAULT_PREFS): Prefs {
	const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
	const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
	return {
		theme: pick(o.theme, THEMES, base.theme),
		keys: bool(o.keys, base.keys),
		markRead: bool(o.markRead, base.markRead),
		images: pick(o.images, IMAGES, base.images),
		replyFrom: bool(o.replyFrom, base.replyFrom),
		shortcuts: o.shortcuts === undefined ? base.shortcuts : cleanOverrides(o.shortcuts),
	};
}

export function samePrefs(a: Prefs, b: Prefs): boolean {
	return a.theme === b.theme && a.keys === b.keys && a.markRead === b.markRead && a.images === b.images && a.replyFrom === b.replyFrom && sameOverrides(a.shortcuts, b.shortcuts);
}
