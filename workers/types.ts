// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** Mail storage on D1 (docs/d1-migration-plan.md). Used when STORAGE is "d1". */
	DB?: D1Database;
	/** "d1" stores mail on D1; anything else, on the Durable Objects. */
	STORAGE?: string;
	/** "true" makes the cron convert attachments to searchable text (D1 only). Costs Workers AI calls per file. */
	ATTACHMENT_SEARCH?: string;
}
