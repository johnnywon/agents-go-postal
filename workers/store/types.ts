// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The storage contract every caller goes through (docs/d1-migration-plan.md).
 * It is met by the Durable Objects and by the D1 store (workers/store/d1/).
 * Method types come from the Durable Object classes for now, so the two can't
 * drift apart; the names listed here are the contract.
 *
 * Index-sync internals (flushIndex, exportIndexRows, indexStatus, applyBatch,
 * rebuild) are not part of it. They exist only to keep the combined index in
 * step with the mailboxes and go away with D1. See `DurableObjectInternals`.
 */
import type { MailboxDO } from "../durableObject";
import type { MailIndexDO } from "../durableObject/mail-index";

/** Operations on one address's mail. */
export type MailboxStore = Pick<
	MailboxDO,
	// Messages and threads
	| "getEmails"
	| "getEmail"
	| "getThreadEmails"
	| "createEmail"
	| "updateEmail"
	| "markThreadRead"
	| "deleteEmail"
	| "trashOrDelete"
	| "moveEmail"
	| "getAttachment"
	| "findThreadBySubject"
	// Folder import (folders to labels)
	| "folderImportCounts"
	| "folderEmailIds"
	| "importFolder"
	| "markFoldersImported"
	// Per-address search (the agent's and MCP's search_emails)
	| "searchEmails"
	// Sending
	| "checkSendRateLimit"
	| "claimSendKey"
	| "finishSendKey"
	| "releaseSendKey"
	| "scheduleSend"
	| "listScheduled"
	| "cancelScheduled"
>;

/** Operations across every address: the combined list, labels, bulk actions and undo. */
export type AllMailStore = Pick<
	MailIndexDO,
	| "queryMail"
	| "queryFacets"
	| "folderViews"
	| "threadKeysMatching"
	| "threadKeyOf"
	| "bulk"
	| "bulkJob"
	| "undo"
	| "trashCount"
	| "emptyTrash"
	| "listLabels"
	| "createLabel"
	| "updateLabel"
	| "markLabelsAuto"
	| "deleteLabel"
>;

export interface MailStore {
	/** One address's mail. The id is the address, any case. */
	mailbox(mailboxId: string): MailboxStore;
	/** Mail across every address. */
	all(): AllMailStore;
	/** The mailboxes themselves. */
	mailboxes: MailboxRegistry;
}

/** The configured addresses and their settings (display name, signature, agent prompt). */
export interface MailboxRegistry {
	/** Every mailbox, sorted by address. */
	list(): Promise<{ id: string; email: string }[]>;
	get(mailboxId: string): Promise<Record<string, unknown> | null>;
	exists(mailboxId: string): Promise<boolean>;
	/** Create the mailbox or replace its settings. */
	put(mailboxId: string, settings: Record<string, unknown>): Promise<void>;
}
