// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Local QA and demo builds (workers/lib/demo.ts). A lived-in sample inbox: about 470
// messages across every configured address, in every folder, with threads,
// attachments, labels, drafts, newsletters and spam, all from made-up
// companies on example.com, example.org and example.net.
//
// `ensureDevMail` runs when the dev server first answers an API request. It
// fills an inbox that has no sample mail, and moves existing sample mail
// forward so the newest message is minutes old. `seedMail` (POST
// /api/v1/dev/seed) wipes the sample mail and writes it again. Mail you
// created yourself is never touched. `resetDemo` (a demo build's hourly cron)
// wipes everything first. Set DEV_SEED=off in .dev.vars to skip it.

import { attachmentKey } from "../../store/d1/rows";
import { mailStore, mailboxIds, recordsSql } from "../../store";
import type { Env } from "../../types";
import { configuredAddresses } from "../addresses";
import { FROM_NAMES } from "./cast";
import { ID_PREFIX, LABELS, NEWEST_MINUTES, SEARCHES, buildInbox, resolveAddresses, toStored } from "./build";
import { ROLES, type Role } from "./kit";

declare const __OMR_TZ_OFFSET__: number | undefined;

export interface SeedSummary {
	messages: number;
	byFolder: Record<string, number>;
	unread: number;
	attachments: number;
	labels: number;
	addresses: Record<Role, string>;
}

async function addressesFor(env: Env): Promise<Record<Role, string>> {
	const configured = configuredAddresses(env);
	return resolveAddresses(configured.length > 0 ? configured : await mailboxIds(env));
}

/** Remove sample mail: the current and older versions, and the "Sample message" rows the first seed route made. */
async function purge(env: Env): Promise<void> {
	const sql = recordsSql(env);
	// The first seed route's rows are told apart by their untouched body: one you edited stays. (D1 caps a LIKE pattern at 50 bytes.)
	await sql.run(`DELETE FROM messages WHERE email_id LIKE 'seed-mail-%' OR (message_id LIKE '%@seed.local' AND body LIKE '<p>Sample message %' AND body LIKE '%a follow-up.</p>')`);
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({ prefix: "attachments/seed-mail-", cursor, limit: 1000 });
		if (page.objects.length > 0) await env.BUCKET.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

/** Wipe the sample mail and write it again. Returns what it wrote. */
export async function seedMail(env: Env, opts: { tzOffset?: number; extra?: number; now?: number } = {}): Promise<SeedSummary> {
	const store = mailStore(env);
	const sql = recordsSql(env);
	const addresses = await addressesFor(env);

	for (const role of ROLES) {
		const addr = addresses[role];
		if (!(await store.mailboxes.exists(addr))) {
			await store.mailboxes.put(addr, { fromName: FROM_NAMES[role], forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } });
		}
	}

	await purge(env);
	const now = opts.now ?? Date.now();
	const tz = opts.tzOffset ?? (typeof __OMR_TZ_OFFSET__ === "number" ? __OMR_TZ_OFFSET__ : 0);
	const inbox = buildInbox({ now, tzOffset: tz, addresses, extra: opts.extra });
	const stored = toStored(inbox);

	const labelIds = new Map<string, string>();
	const existing = await store.all().listLabels();
	for (const spec of LABELS) {
		const found = existing.find((l) => l.name.toLowerCase() === spec.name.toLowerCase());
		if (found) labelIds.set(spec.name, found.id);
		else {
			const made = await store.all().createLabel({ name: spec.name, color: spec.color });
			if ("label" in made && made.label) labelIds.set(spec.name, made.label.id);
		}
	}

	for (const s of stored) {
		await Promise.all(s.attachments.map((a) => env.BUCKET.put(attachmentKey(a), a.bytes, { httpMetadata: { contentType: a.mimetype } })));
		await store.mailbox(inbox.addresses[s.msg.box]).createEmail(s.msg.folder, s.email, s.attachments);
	}

	for (const [name, id] of labelIds) {
		const ids = stored.filter((s) => s.msg.labels?.includes(name)).map((s) => s.id);
		if (ids.length > 0) await sql.run(`INSERT OR IGNORE INTO message_labels (message, label_id) SELECT id, ? FROM messages WHERE email_id IN (SELECT value FROM json_each(?))`, id, JSON.stringify(ids));
	}

	const saved = await store.all().listSavedSearches();
	for (const search of SEARCHES) {
		if (!saved.some((s) => s.name === search.name)) await store.all().createSavedSearch(search);
	}

	const byFolder: Record<string, number> = {};
	for (const s of stored) byFolder[s.msg.folder] = (byFolder[s.msg.folder] ?? 0) + 1;
	return {
		messages: stored.length, byFolder, unread: stored.filter((s) => !s.msg.read && s.msg.folder === "inbox").length,
		attachments: stored.reduce((n, s) => n + s.attachments.length, 0), labels: labelIds.size, addresses,
	};
}

/**
 * A demo build's hourly reset: drop everything visitors made or changed (mail,
 * files, labels, saved searches, undo history), then write the sample inbox again.
 */
export async function resetDemo(env: Env, now = Date.now()): Promise<SeedSummary> {
	const sql = recordsSql(env);
	for (const table of ["messages", "labels", "saved_searches", "bulk_job", "undo"]) await sql.run(`DELETE FROM ${table}`);
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({ prefix: "attachments/", cursor, limit: 1000 });
		if (page.objects.length > 0) await env.BUCKET.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return seedMail(env, { now });
}

/**
 * Move the sample mail forward when the server has been off for a while,
 * keeping what you read, starred and labelled. After two weeks the dates quoted
 * inside replies would be far off, so it writes the inbox again.
 */
async function refresh(env: Env, newest: string): Promise<string | null> {
	const delta = Date.now() - NEWEST_MINUTES * 60_000 - Date.parse(newest);
	if (delta < 30 * 60_000) return null;
	if (delta > 14 * 86_400_000) return `${(await seedMail(env)).messages} messages, replaced after ${Math.round(delta / 86_400_000)} days`;
	await recordsSql(env).run(
		`UPDATE messages SET date = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(date) + ? / 86400000.0) WHERE email_id LIKE ?`,
		delta, `${ID_PREFIX}%`,
	);
	return `moved forward ${Math.round(delta / 3_600_000)} hours`;
}

let started: Promise<void> | undefined;

/** Called on the dev server's first API request. Never throws: a failed seed must not break the app. */
export function ensureDevMail(env: Env): Promise<void> {
	started ??= (async () => {
		if (String(env.DEV_SEED ?? "").toLowerCase() === "off") return;
		try {
			const row = await recordsSql(env).first(`SELECT COUNT(*) AS n, MAX(date) AS newest FROM messages WHERE email_id LIKE ?`, `${ID_PREFIX}%`);
			if (Number(row?.n) > 0) {
				const moved = await refresh(env, String(row?.newest));
				if (moved) console.log(`[dev seed] sample inbox ${moved}`);
				return;
			}
			const t = Date.now();
			const summary = await seedMail(env);
			console.log(`[dev seed] sample inbox written: ${summary.messages} messages in ${Date.now() - t} ms (DEV_SEED=off in .dev.vars skips it)`);
		} catch (e) {
			console.warn(`[dev seed] skipped: ${(e as Error).message}. Run the D1 migrations first if the database is new.`);
		}
	})();
	return started;
}
