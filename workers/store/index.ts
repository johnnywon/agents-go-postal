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
import type { MailStore } from "./types";

export type { AllMailStore, MailboxStore, MailStore } from "./types";

function mailboxStub(env: Env, mailboxId: string): DurableObjectStub<MailboxDO> {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

function indexStub(env: Env): DurableObjectStub<MailIndexDO> {
	return env.MAIL_INDEX.get(env.MAIL_INDEX.idFromName("global"));
}

export function mailStore(env: Env): MailStore {
	return {
		mailbox: (mailboxId) => mailboxStub(env, mailboxId),
		all: () => indexStub(env),
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
