// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export const SETTINGS_TABS = ["general", "addresses", "signatures", "labels", "shortcuts", "agent", "model", "activity", "storage"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tab named by ?settings=, or null. "index" is the old name of Storage. */
export function settingsTabFrom(value: string | null): SettingsTab | null {
	if (value === "index") return "storage";
	return (SETTINGS_TABS as readonly string[]).includes(value ?? "") ? (value as SettingsTab) : null;
}
