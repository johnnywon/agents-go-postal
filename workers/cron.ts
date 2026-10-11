// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The one-minute cron. On D1 it sends due scheduled mail. On the Durable
 * Object store it does nothing: each mailbox's alarm sends its own.
 */
import { sendDueScheduledMail, usesD1 } from "./store";
import type { Env } from "./types";

export async function runCron(env: Env, now = Date.now()) {
	if (!usesD1(env)) return { skipped: true as const };
	const scheduled = await sendDueScheduledMail(env, now);
	if (scheduled.failed.length > 0) console.error(`scheduled send failed for ${scheduled.failed.length} message(s)`);
	return { skipped: false as const, scheduled };
}
