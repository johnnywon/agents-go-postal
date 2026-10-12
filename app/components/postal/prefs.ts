// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { cleanPrefs, DEFAULT_PREFS, type Prefs, samePrefs } from "shared/prefs";
import api from "~/services/api";

export { DEFAULT_PREFS, type Prefs };

export interface Layout {
	/** Wide-screen state of the side rails; null follows the default. */
	nav: boolean | null;
	panel: boolean | null;
	mailboxesOpen: boolean;
	labelsOpen: boolean;
}

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

/** This browser's copy of the prefs. Pages rendered on the server apply it after hydration. */
export function readPrefs(): Prefs {
	return cleanPrefs(readJson<Record<string, unknown>>(PREFS_KEY, {}));
}

const PREFS_QUERY = ["prefs"] as const;

/** The deployment's prefs. The first browser to find none saved uploads its own copy, so settings made before carry over. */
async function fetchPrefs(): Promise<Prefs> {
	const { prefs, saved } = await api.getPrefs();
	if (saved) {
		writeJson(PREFS_KEY, prefs);
		return prefs;
	}
	const local = readPrefs();
	if (samePrefs(local, DEFAULT_PREFS)) return prefs;
	return (await api.savePrefs(local)).prefs;
}

/**
 * Settings > General, saved to the deployment. Every caller shares one copy. It starts from this browser's copy so the
 * theme is right on the first paint, then follows the server. update() applies at once and resolves when it is saved.
 */
export function usePrefs() {
	const queryClient = useQueryClient();
	const { data } = useQuery({
		queryKey: PREFS_QUERY,
		queryFn: fetchPrefs,
		initialData: readPrefs,
		initialDataUpdatedAt: 0,
		staleTime: 60_000,
		retry: false,
	});
	const update = useCallback(async (patch: Partial<Prefs>) => {
		const next = cleanPrefs(patch, queryClient.getQueryData<Prefs>(PREFS_QUERY) ?? readPrefs());
		queryClient.setQueryData(PREFS_QUERY, next);
		writeJson(PREFS_KEY, next);
		const saved = (await api.savePrefs(next)).prefs;
		queryClient.setQueryData(PREFS_QUERY, saved);
		writeJson(PREFS_KEY, saved);
		return saved;
	}, [queryClient]);
	return [data, update] as const;
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
