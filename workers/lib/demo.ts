// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// A demo build (OMR_DEMO=1 npm run build) comes up filled with the sample
// inbox and lets anyone read, file and label it. It never sends mail, never
// calls a model, keeps settings read-only and needs no sign-in. The cron
// writes the sample inbox again every hour.
//
// vite.config.ts defines __OMR_DEMO__ as a literal, so in a normal build DEMO
// is false and every branch on it, with the sample inbox, is left out.

declare const __OMR_DEMO__: boolean | undefined;

export const DEMO: boolean = typeof __OMR_DEMO__ === "boolean" && __OMR_DEMO__;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Writes a demo visitor may make: filing, labels, saved searches, drafts. Everything else is refused. */
const ALLOWED: [method: string, path: RegExp][] = [
	["POST", /^\/api\/v1\/mail\/bulk(\/undo)?$/],
	["POST", /^\/api\/v1\/mail\/empty-trash$/],
	["POST", /^\/api\/v1\/saved-searches$/],
	["PUT", /^\/api\/v1\/saved-searches\/[^/]+$/],
	["DELETE", /^\/api\/v1\/saved-searches\/[^/]+$/],
	["POST", /^\/api\/v1\/labels(\/import-folders)?$/],
	["PUT", /^\/api\/v1\/labels\/[^/]+$/],
	["DELETE", /^\/api\/v1\/labels\/[^/]+$/],
	["POST", /^\/api\/v1\/mailboxes\/[^/]+\/drafts$/],
	["DELETE", /^\/api\/v1\/mailboxes\/[^/]+\/emails\/[^/]+$/],
	["DELETE", /^\/api\/v1\/mailboxes\/[^/]+\/scheduled\/[^/]+$/],
	["POST", /^\/api\/v1\/mailboxes\/[^/]+\/threads\/[^/]+\/read$/],
];

const SENDS = /^\/api\/v1\/mailboxes\/[^/]+\/(emails|scheduled|emails\/[^/]+\/(reply|forward))$/;
const AI = /^\/api\/v1\/(search\/interpret|agent-model\/test|mailboxes\/[^/]+\/drafts\/[^/]+\/redraft)$/;

/** Why a demo refuses this API request, or null when it may go ahead. */
export function demoRefusal(method: string, path: string): string | null {
	if (SAFE_METHODS.has(method)) return null;
	if (ALLOWED.some(([m, re]) => m === method && re.test(path))) return null;
	if (SENDS.test(path)) return "Sending is off in the demo";
	if (AI.test(path)) return "AI is off in the demo";
	return "Settings are read-only in the demo";
}

/** Paths outside the API that a demo refuses: the MCP server and the agent socket. */
export function demoBlocksPath(path: string): boolean {
	return path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/agents/");
}
