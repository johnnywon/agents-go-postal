// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";
import { listMailboxes } from "./email-helpers";

/** Kill switch: `INDEX_SYNC_ENABLED = "false"` stops mailbox pushes. Mutations still record to the outbox. */
export function indexSyncEnabled(env: Env): boolean {
	return String(env.INDEX_SYNC_ENABLED ?? "true") !== "false";
}

/** Mailboxes that exist in R2 and are configured in EMAIL_ADDRESSES, sorted. */
export async function indexedMailboxIds(env: Env): Promise<string[]> {
	const configured = new Set(((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase()));
	return (await listMailboxes(env.BUCKET))
		.map((mailbox) => mailbox.id.toLowerCase())
		.filter((id) => configured.size === 0 || configured.has(id))
		.sort();
}
