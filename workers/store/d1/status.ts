// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The mail index status page on D1. D1 keeps one copy of the mail, so each
 * address's counts and the "index" counts are the same rows and always match.
 * Same response shape as the Durable Object store's parity check.
 */
import type { Sql } from "../sql";

export async function d1IndexStatus(sql: Sql, mailboxIds: string[]) {
	const [byState, conversations, total] = await sql.batch([
		{
			sql: `SELECT mailbox_id, state, COUNT(*) AS n, SUM(CASE WHEN unread = 1 AND state = 'inbox' THEN 1 ELSE 0 END) AS unread,
				SUM(starred) AS starred FROM messages GROUP BY mailbox_id, state`,
		},
		{ sql: `SELECT mailbox_id, COUNT(DISTINCT thread_key) AS n FROM messages WHERE state = 'inbox' GROUP BY mailbox_id` },
		{ sql: `SELECT COUNT(*) AS n FROM messages` },
	]);
	const counts = new Map<string, { states: Record<string, number>; unread: number; starred: number; total: number; inboxConversations: number }>();
	const entry = (id: string) => {
		const existing = counts.get(id);
		if (existing) return existing;
		const created = { states: {}, unread: 0, starred: 0, total: 0, inboxConversations: 0 };
		counts.set(id, created);
		return created;
	};
	for (const row of byState) {
		const e = entry(String(row.mailbox_id));
		e.states[String(row.state)] = Number(row.n);
		e.unread += Number(row.unread);
		e.starred += Number(row.starred);
		e.total += Number(row.n);
	}
	for (const row of conversations) entry(String(row.mailbox_id)).inboxConversations = Number(row.n);
	return {
		storage: "d1" as const,
		messages: Number(total[0]?.n ?? 0),
		job: null,
		probe: null,
		mailboxes: mailboxIds.map((mailboxId) => {
			const { inboxConversations, ...rest } = entry(mailboxId);
			return {
				mailboxId,
				source: { mailboxId, seq: 0, pending: 0, counts: rest, inboxConversations },
				index: { ...rest, inboxConversations, appliedSeq: 0 },
			};
		}),
	};
}
