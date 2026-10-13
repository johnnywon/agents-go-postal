// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Send limits per address, enforced in workers/lib/send-budget.ts and shown in Settings > Agent. */

export const SEND_LIMITS = {
	/** Every sender, per address. */
	hour: 20,
	day: 100,
	/** Agents and MCP together, per address, inside the daily limit. */
	agentDay: 20,
	/** Recipients on one message, To, Cc and Bcc together. */
	recipients: { person: 50, agent: 10 },
} as const;

/** Auto-drafts per sender per address in a day. Later mail from that sender is stored but not drafted. */
export const AUTO_DRAFT_SENDER_DAILY = 3;
