// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The one-minute cron. It sends due scheduled mail, then, when
 * ATTACHMENT_SEARCH is "true", converts a few attachments to searchable text.
 * Once an hour it deletes activity and auto-draft runs past the retention,
 * and marks failed the auto-draft runs whose worker died.
 */
import { failAbandonedRuns, pruneRuns } from "./agent/runs";
import { pruneActivity } from "./lib/activity";
import { readPrefs } from "./lib/prefs";
import { extractAttachmentTextBatch, sendDueScheduledMail, recordsSql } from "./store";
import type { Env } from "./types";

/** Delete activity log rows and auto-draft runs older than the retention in prefs; fail abandoned runs. */
export async function pruneAgentHistory(env: Env, now = Date.now()) {
	const { prefs } = await readPrefs(env);
	const sql = recordsSql(env);
	return {
		days: prefs.activityDays,
		activity: await pruneActivity(sql, prefs.activityDays, now),
		runs: await pruneRuns(sql, prefs.activityDays, now),
		abandoned: await failAbandonedRuns(sql, now),
	};
}

export async function runCron(env: Env, now = Date.now()) {
	const scheduled = await sendDueScheduledMail(env, now);
	if (scheduled.failed.length > 0) console.error(`scheduled send failed for ${scheduled.failed.length} message(s)`);
	const attachments = String(env.ATTACHMENT_SEARCH ?? "") === "true"
		? await extractAttachmentTextBatch(env, now).catch((e) => {
			console.error("attachment text failed:", (e as Error).message);
			return null;
		})
		: null;
	const pruned = new Date(now).getUTCMinutes() === 0
		? await pruneAgentHistory(env, now).catch((e) => {
			console.error("activity prune failed:", (e as Error).message);
			return null;
		})
		: null;
	return { scheduled, attachments, pruned };
}
