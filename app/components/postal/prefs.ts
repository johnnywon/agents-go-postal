// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useCallback, useEffect, useState } from "react";

/** Per-browser preferences. Nothing here reaches the server. */
export interface Prefs {
	theme: "dark" | "light" | "system";
	/** Show key hints next to controls. Shortcuts work either way. */
	keys: boolean;
	markRead: boolean;
	images: "ask" | "always" | "never";
	replyFrom: boolean;
}

export interface Layout {
	/** Wide-screen state of the side rails; null follows the default. */
	nav: boolean | null;
	panel: boolean | null;
	mailboxesOpen: boolean;
	labelsOpen: boolean;
}

export const DEFAULT_PREFS: Prefs = { theme: "dark", keys: true, markRead: true, images: "ask", replyFrom: true };
const DEFAULT_LAYOUT: Layout = { nav: null, panel: null, mailboxesOpen: true, labelsOpen: true };

const PREFS_KEY = "agp-prefs";
const LAYOUT_KEY = "agp-layout";

export function readJson<T>(key: string, fallback: T): T {
	if (typeof window === "undefined") return fallback;
	try {
		const raw = window.localStorage.getItem(key);
		return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
	} catch {
		return fallback;
	}
}

export function writeJson(key: string, value: unknown) {
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Blocked storage: the setting lasts for this page only.
	}
}

function useStored<T extends object>(key: string, fallback: T) {
	// The postal view renders only in the browser (it waits for /config), so storage is readable here.
	const [value, setValue] = useState<T>(() => readJson(key, fallback));
	const update = useCallback(
		(patch: Partial<T>) =>
			setValue((prev) => {
				const next = { ...prev, ...patch };
				writeJson(key, next);
				return next;
			}),
		[key],
	);
	return [value, update] as const;
}

/** Stored prefs, for pages rendered on the server that apply them after hydration. */
export function readPrefs(): Prefs {
	return readJson<Prefs>(PREFS_KEY, DEFAULT_PREFS);
}

export function usePrefs() {
	return useStored<Prefs>(PREFS_KEY, DEFAULT_PREFS);
}

export function useLayout() {
	return useStored<Layout>(LAYOUT_KEY, DEFAULT_LAYOUT);
}

/** Resolved theme, following the OS when set to System. */
export function useResolvedTheme(theme: Prefs["theme"]): "dark" | "light" {
	const [systemLight, setSystemLight] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches);
	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: light)");
		setSystemLight(mq.matches);
		const on = () => setSystemLight(mq.matches);
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	if (theme === "system") return systemLight ? "light" : "dark";
	return theme;
}

export function useWidth(): number {
	const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
	useEffect(() => {
		const on = () => setWidth(window.innerWidth);
		on();
		window.addEventListener("resize", on);
		return () => window.removeEventListener("resize", on);
	}, []);
	return width;
}
