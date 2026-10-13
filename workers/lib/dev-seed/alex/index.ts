// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// The Alex profile (SEED_PROFILE=alex): three weeks in the life of Alex
// Rivera, who runs Partwell, an API that normalizes manufacturers' catalogs.
// 47 messages across seven mailboxes: customers, vendors, a late-night
// incident and its recovery, invoices and a payout, food orders, a keyboard,
// a friend, an agency client and an eight-person fantasy league.
//
// Pure data, like ../build.ts: ../index.ts writes it. docs/demo-alex.md lists
// every message, and assets/manifest.json the photos' sources and licenses.

import type { Inbox } from "../build";
import type { LabelSpec } from "../kit";
import { businessSlots } from "./business";
import { ALEX_ADDRESSES } from "./cast";
import { StoryClock } from "./clock";
import { personalSlots } from "./personal";
import { toMsgs } from "./slots";

export { ALEX_ADDRESSES, ALEX_BOXES, ALEX_FROM_NAMES } from "./cast";

/** Stored ids start with this. Bump the version when the messages change shape. */
export const ALEX_PREFIX = "seed-alex-v1-";

/** Colours from the label palette (shared/label-colors.ts); fifteen labels share twelve. */
export const ALEX_LABELS: LabelSpec[] = [
	{ name: "Cedar", color: "#2e8b84" },
	{ name: "Support", color: "#2f6db3" },
	{ name: "Resolved", color: "#4f8a3c" },
	{ name: "Waiting on customer", color: "#e2c044" },
	{ name: "Incident", color: "#c8372d" },
	{ name: "Follow up", color: "#d9822b" },
	{ name: "Billing", color: "#7a5a3a" },
	{ name: "Receipts", color: "#5f6b74" },
	{ name: "Vendors", color: "#5b4fb0" },
	{ name: "Dev", color: "#2d2f31" },
	{ name: "Newsletters", color: "#b9c4cb" },
	{ name: "Clients", color: "#2e8b84" },
	{ name: "Personal", color: "#b0457f" },
	{ name: "Shopping", color: "#e2c044" },
	{ name: "Fantasy", color: "#4f8a3c" },
];

export const ALEX_SEARCHES: { name: string; query: string }[] = [
	{ name: "Needs follow-up", query: 'label:"follow up"' },
	{ name: "Incident", query: "label:incident" },
	{ name: "Cedar", query: "label:cedar" },
];

export function buildAlex(now: number): Inbox & { clock: StoryClock } {
	const clock = new StoryClock(now);
	const messages = toMsgs(clock, [...businessSlots(clock), ...personalSlots(clock)]);
	messages.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
	return { messages, addresses: ALEX_ADDRESSES, clock };
}
