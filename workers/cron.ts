// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The one-minute cron. It sends due scheduled mail, then, when
 * ATTACHMENT_SEARCH is "true", converts a few attachments to searchable text.
 */
import { extractAttachmentTextBatch, sendDueScheduledMail } from "./store";
import type { Env } from "./types";

export async function runCron(env: Env, now = Date.now()) {
	const scheduled = await sendDueScheduledMail(env, now);
	if (scheduled.failed.length > 0) console.error(`scheduled send failed for ${scheduled.failed.length} message(s)`);
	const attachments = String(env.ATTACHMENT_SEARCH ?? "") === "true"
		? await extractAttachmentTextBatch(env, now).catch((e) => {
			console.error("attachment text failed:", (e as Error).message);
			return null;
		})
		: null;
	return { scheduled, attachments };
}
