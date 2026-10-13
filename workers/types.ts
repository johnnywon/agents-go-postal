// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** "true" makes the cron convert attachments to searchable text. Costs Workers AI calls per file. */
	ATTACHMENT_SEARCH?: string;
	/** "off" in .dev.vars keeps the local dev server from filling the inbox with sample mail. */
	DEV_SEED?: string;
}
