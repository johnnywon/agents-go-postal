// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Settings > General for the deployment, in R2 next to the agent model config. */

import { cleanPrefs, DEFAULT_PREFS, type Prefs } from "../../shared/prefs";
import type { Env } from "../types";

const PREFS_KEY = "config/prefs.json";

/** The saved prefs, and whether anything was saved yet (a browser uploads its own copy the first time). */
export async function readPrefs(env: Env): Promise<{ prefs: Prefs; saved: boolean }> {
	const obj = await env.BUCKET.get(PREFS_KEY);
	if (!obj) return { prefs: DEFAULT_PREFS, saved: false };
	try {
		return { prefs: cleanPrefs(await obj.json()), saved: true };
	} catch {
		return { prefs: DEFAULT_PREFS, saved: false };
	}
}

/** Merge a patch over what is saved, keep only valid fields, and save. */
export async function writePrefs(env: Env, patch: unknown): Promise<Prefs> {
	const { prefs: current } = await readPrefs(env);
	const next = cleanPrefs(patch, current);
	await env.BUCKET.put(PREFS_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
	return next;
}
