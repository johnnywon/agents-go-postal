// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The storage contract every caller goes through (docs/d1-migration-plan.md).
 * Today it is met by the Durable Objects; the D1 store will implement the
 * same methods. Method types come from the Durable Object stubs for now, so
 * the two can't drift apart; the names listed here are the contract.
 *
 * Index-sync internals (flushIndex, exportIndexRows, indexStatus, applyBatch,
 * rebuild) are not part of it. They exist only to keep the combined index in
 * step with the mailboxes and go away with D1. See `DurableObjectInternals`.
 */
import type { MailboxDO } from "../durableObject";
import type { MailIndexDO } from "../durableObject/mail-index";

/** Operations on one address's mail. */
export type MailboxStore = Pick<
	DurableObjectStub<MailboxDO>,
	// Messages and threads
	| "getEmails"
	| "countEmails"
	| "getThreadedEmails"
	| "countThreadedEmails"
	| "getEmail"
	| "getThreadEmails"
	| "createEmail"
	| "updateEmail"
	| "updateEmails"
	| "markThreadRead"
	| "deleteEmail"
	| "trashOrDelete"
	| "purgeTrash"
	| "moveEmail"
	| "moveEmails"
	| "setLabels"
	| "getAttachment"
	| "findThreadBySubject"
	// Folders
	| "getFolders"
	| "createFolder"
	| "updateFolder"
	| "deleteFolder"
	| "folderImportCounts"
	| "folderEmailIds"
	| "importFolder"
	| "markFoldersImported"
	// Per-address search (the classic view and search_emails)
	| "searchEmails"
	| "countSearchResults"
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
	DurableObjectStub<MailIndexDO>,
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
}
