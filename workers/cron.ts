// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The one-minute cron. With a D1 database bound it advances the copy from
 * the Durable Objects, if one is running. On D1 it then sends due scheduled
 * mail; on the Durable Object store each mailbox's alarm sends its own.
 * Then it checks a batch of older mail for has:link and, when
 * ATTACHMENT_SEARCH is "true", converts a few attachments to searchable text.
 */
import { backfillLinkColumn, extractAttachmentTextBatch, hasD1, sendDueScheduledMail, usesD1 } from "./store";
import { advanceCopy } from "./store/copy-job";
import type { Env } from "./types";

export async function runCron(env: Env, now = Date.now()) {
	let copy: Awaited<ReturnType<typeof advanceCopy>> | "failed" = "none";
	if (hasD1(env)) {
		// The copy's final pass runs before sending, so the scheduled sends it brings over are current.
		copy = await advanceCopy(env).catch((e) => {
			if (/no such table/.test((e as Error).message)) return "none" as const; // migrations not applied yet
			console.error("copy to D1 failed:", (e as Error).message);
			return "failed" as const;
		});
	}
	if (!usesD1(env)) return { copy, skipped: true as const };
	const scheduled = await sendDueScheduledMail(env, now);
	if (scheduled.failed.length > 0) console.error(`scheduled send failed for ${scheduled.failed.length} message(s)`);
	const links = await backfillLinkColumn(env).catch((e) => {
		// Before migrations/0002_has_link.sql is applied the column doesn't exist; nothing to do yet.
		if (!/no such column/.test((e as Error).message)) console.error("has:link backfill failed:", (e as Error).message);
		return 0;
	});
	const attachments = String(env.ATTACHMENT_SEARCH ?? "") === "true"
		? await extractAttachmentTextBatch(env, now).catch((e) => {
			console.error("attachment text failed:", (e as Error).message);
			return null;
		})
		: null;
	return { copy, skipped: false as const, scheduled, links, attachments };
}
