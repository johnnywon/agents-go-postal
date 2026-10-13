// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** The console's tabs: the agents' sections, then the mail client's settings. */
export const AGENT_TABS = ["overview", "activity", "limits", "drafting", "model", "connections"] as const;
export const SETTINGS_TABS = ["general", "addresses", "signatures", "labels", "shortcuts", "storage"] as const;
export const CONSOLE_TABS = [...AGENT_TABS, ...SETTINGS_TABS] as const;
export type ConsoleTab = (typeof CONSOLE_TABS)[number];

/** Names from before the console: ?settings=agent, ?settings=index and the MCP dialog. */
const RENAMED: Record<string, ConsoleTab> = { agent: "drafting", index: "storage", mcp: "connections" };

function tabNamed(value: string | null): ConsoleTab | null {
	if (!value) return null;
	if (value in RENAMED) return RENAMED[value];
	return (CONSOLE_TABS as readonly string[]).includes(value) ? (value as ConsoleTab) : null;
}

/** The tab named by ?console=, or by the older ?settings=. Null when the console is closed. */
export function consoleTabFrom(params: URLSearchParams): ConsoleTab | null {
	return tabNamed(params.get("console")) ?? tabNamed(params.get("settings"));
}
