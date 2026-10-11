// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `mailStore(env)` is the one way callers reach mail storage. It returns the
 * Durable Object store today; the D1 store slots in here behind a `STORAGE`
 * setting during the move (docs/d1-migration-plan.md, Rollout).
 */
import type { MailboxDO } from "../durableObject";
import type { MailIndexDO } from "../durableObject/mail-index";
import type { Env } from "../types";
import { D1AllMail } from "./d1/all-mail";
import { D1Mailbox } from "./d1/mailbox";
import { d1Registry } from "./d1/registry";
import { sendDueScheduled } from "./d1/scheduled";
import { d1IndexStatus } from "./d1/status";
import { d1Sql } from "./sql";
import type { AllMailStore, MailboxRegistry, MailboxStore, MailStore } from "./types";

export type { AllMailStore, MailboxRegistry, MailboxStore, MailStore } from "./types";

function mailboxStub(env: Env, mailboxId: string): DurableObjectStub<MailboxDO> {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

function indexStub(env: Env): DurableObjectStub<MailIndexDO> {
	return env.MAIL_INDEX.get(env.MAIL_INDEX.idFromName("global"));
}

const settingsKey = (mailboxId: string) => `mailboxes/${mailboxId.toLowerCase()}.json`;

/** Mailboxes as R2 records, for the Durable Object store. `put` also tells the mailbox its address. */
function r2Registry(env: Env): MailboxRegistry {
	return {
		async list() {
			const list = await env.BUCKET.list({ prefix: "mailboxes/" });
			return list.objects
				.map((obj) => obj.key.replace("mailboxes/", "").replace(".json", ""))
				.sort()
				.map((id) => ({ id, email: id }));
		},
		async get(mailboxId) {
			const object = await env.BUCKET.get(settingsKey(mailboxId));
			return object ? await object.json<Record<string, unknown>>() : null;
		},
		async exists(mailboxId) {
			return !!(await env.BUCKET.head(settingsKey(mailboxId)));
		},
		async put(mailboxId, settings) {
			await env.BUCKET.put(settingsKey(mailboxId), JSON.stringify(settings));
			await mailboxStub(env, mailboxId.toLowerCase()).setMailboxId(mailboxId.toLowerCase());
		},
	};
}

/** A D1 database is bound, whichever store is in use. The copy to D1 needs one. */
export function hasD1(env: Env): boolean {
	return !!env.DB;
}

/** `STORAGE = "d1"` with a `DB` binding picks the D1 store; anything else, the Durable Objects. */
export function usesD1(env: Env): boolean {
	return String(env.STORAGE ?? "") === "d1" && !!env.DB;
}

export function mailStore(env: Env): MailStore {
	if (usesD1(env)) {
		const sql = d1Sql(env.DB!);
		const d1: MailStore = {
			mailbox: (mailboxId) => new D1Mailbox(sql, env.BUCKET, mailboxId),
			all: () => new D1AllMail(sql, env.BUCKET),
			mailboxes: d1Registry(sql),
		};
		return d1;
	}
	return {
		// Stub method types wrap results for RPC; the values are the same.
		mailbox: (mailboxId) => mailboxStub(env, mailboxId) as unknown as MailboxStore,
		all: () => indexStub(env) as unknown as AllMailStore,
		mailboxes: r2Registry(env),
	};
}

/**
 * The Durable Object stubs themselves, for index-sync work that is outside
 * the contract: index status and rebuild, teaching a mailbox its address,
 * purging a mailbox from the index, and the copy to D1. Removed with the Durable Objects.
 */
export function durableObjectInternals(env: Env) {
	return {
		mailbox: (mailboxId: string) => mailboxStub(env, mailboxId),
		index: () => indexStub(env),
		/** The R2 mailbox records, whatever STORAGE says. The copy to D1 reads them. */
		registry: r2Registry(env),
	};
}

/** The mail index status page when mail is on D1 (see d1/status.ts). */
export function d1Status(env: Env, mailboxIds: string[]) {
	return d1IndexStatus(d1Sql(env.DB!), mailboxIds);
}

/** Due scheduled mail on D1, sent by the cron (see d1/scheduled.ts). */
export function sendDueScheduledMail(env: Env, now = Date.now()) {
	return sendDueScheduled(env, d1Sql(env.DB!), now);
}
