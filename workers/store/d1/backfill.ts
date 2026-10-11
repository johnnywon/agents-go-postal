// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Columns added after mail was stored, filled in a batch per cron run.
 * `has_link` (migrations/0002_has_link.sql) is NULL until checked. A body in
 * R2 counts as no link; reading each one back would cost an R2 call.
 */
import type { Sql } from "../sql";
import { LINK_SQL } from "./rows";

export const LINK_BATCH = 200;

/** Check up to `limit` unchecked messages. Returns how many were checked. */
export async function backfillLinks(sql: Sql, limit = LINK_BATCH): Promise<number> {
	const { changes } = await sql.run(
		`UPDATE messages SET has_link = CASE WHEN body IS NOT NULL AND ${LINK_SQL} THEN 1 ELSE 0 END
		WHERE id IN (SELECT id FROM messages WHERE has_link IS NULL LIMIT ?)`,
		limit,
	);
	return changes;
}
