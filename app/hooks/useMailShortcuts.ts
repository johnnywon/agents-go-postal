// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useRef } from "react";

export interface KeyLike {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	isComposing?: boolean;
	defaultPrevented?: boolean;
	target?: EventTarget | null;
}

const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

/**
 * Whether a key press belongs to the mail shortcuts: not while typing, not
 * during IME composition, not with modifiers, not inside a dialog or popover,
 * and not when something else already handled it. Escape always passes.
 */
export function shouldHandleKey(event: KeyLike): boolean {
	if (event.defaultPrevented || event.isComposing) return false;
	if (event.metaKey || event.ctrlKey || event.altKey) return false;
	const target = event.target as Element | null;
	if (event.key === "Escape") return true;
	if (target && typeof (target as Element).closest === "function") {
		if ((target as Element).closest(EDITABLE)) return false;
		if ((target as Element).closest("[role='dialog'], [data-mail-popover]")) return false;
	}
	return true;
}

export type MailShortcut =
	| "next" | "previous" | "search" | "keys" | "escape" | "select" | "label" | "archive" | "delete" | "star" | "read";

const KEY_MAP: Record<string, MailShortcut> = {
	j: "next", k: "previous", "/": "search", "?": "keys", Escape: "escape", x: "select", l: "label",
	e: "archive", "#": "delete", s: "star", u: "read",
};

/** Keys a message frame forwards to the page. */
export const SHORTCUT_KEYS = Object.keys(KEY_MAP);

export function shortcutFor(event: KeyLike): MailShortcut | null {
	if (!shouldHandleKey(event)) return null;
	return KEY_MAP[event.key] ?? null;
}

/** One document-level listener. Keys typed inside a message frame arrive through postMessage. */
export function useMailShortcuts(handlers: Partial<Record<MailShortcut, () => void>>) {
	const ref = useRef(handlers);
	ref.current = handlers;
	useEffect(() => {
		const run = (shortcut: MailShortcut | null, event?: Event) => {
			const handler = shortcut && ref.current[shortcut];
			if (!handler) return;
			event?.preventDefault();
			handler();
		};
		const onKey = (event: KeyboardEvent) => run(shortcutFor(event), event);
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { __emailIframeKey?: boolean; key?: string } | null;
			if (!data || data.__emailIframeKey !== true || typeof data.key !== "string") return;
			if (![...document.querySelectorAll("iframe")].some((frame) => frame.contentWindow === event.source)) return;
			run(KEY_MAP[data.key] ?? null);
		};
		document.addEventListener("keydown", onKey);
		window.addEventListener("message", onMessage);
		return () => {
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("message", onMessage);
		};
	}, []);
}
