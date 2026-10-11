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
import { d1Sql } from "./sql";
import type { AllMailStore, MailboxStore, MailStore } from "./types";

export type { AllMailStore, MailboxStore, MailStore } from "./types";

function mailboxStub(env: Env, mailboxId: string): DurableObjectStub<MailboxDO> {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

function indexStub(env: Env): DurableObjectStub<MailIndexDO> {
	return env.MAIL_INDEX.get(env.MAIL_INDEX.idFromName("global"));
}

/** `STORAGE = "d1"` with a `DB` binding picks the D1 store; anything else, the Durable Objects. */
export function usesD1(env: Env): boolean {
	return String((env as { STORAGE?: string }).STORAGE ?? "") === "d1" && !!(env as { DB?: D1Database }).DB;
}

export function mailStore(env: Env): MailStore {
	if (usesD1(env)) {
		const sql = d1Sql((env as unknown as { DB: D1Database }).DB);
		const d1: MailStore = {
			mailbox: (mailboxId) => new D1Mailbox(sql, env.BUCKET, mailboxId),
			all: () => new D1AllMail(sql, env.BUCKET),
		};
		return d1;
	}
	return {
		// Stub method types wrap results for RPC; the values are the same.
		mailbox: (mailboxId) => mailboxStub(env, mailboxId) as unknown as MailboxStore,
		all: () => indexStub(env) as unknown as AllMailStore,
	};
}

/**
 * The Durable Object stubs themselves, for index-sync work that is outside
 * the contract: index status and rebuild, teaching a mailbox its address,
 * and purging a mailbox from the index. Removed with the Durable Objects.
 */
export function durableObjectInternals(env: Env) {
	return {
		mailbox: (mailboxId: string) => mailboxStub(env, mailboxId),
		index: () => indexStub(env),
	};
}
