// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import { isSystemFolder } from "./mailbox-bulk";
import { getMailIndexStub } from "./mail-index-stub";
import type { EmailFull } from "./schemas";
import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxes,
} from "./email-helpers";
import { verifyDraft } from "./ai";
import { Folders } from "../../shared/folders";
import { LABEL_COLORS } from "../../shared/label-colors";
import type { Env } from "../types";

// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
	searchEmails: (options: {
		query: string;
		folder?: string;
	}) => Promise<unknown>;
};

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxes(env.BUCKET);
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.getEmails({
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	});
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(
	env: Env,
	mailboxId: string,
	threadId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	return getFullThread(stub, threadId);
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	return (stub as unknown as MailboxSearchStub).searchEmails({
		query: params.query,
		folder: params.folder,
	});
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, runs AI verifyDraft on the body.
 *   The agent and MCP both do this, but the agent does it on plain text
 *   while MCP does it on HTML.
 */
export async function toolDraftReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
	},
): Promise<
	| { status: "draft_saved"; draftId: string; message: string; draft: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Verify/sanitize if requested
	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	// Convert plain text to HTML if needed
	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Get the original email for thread_id and quoted text
	const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	const threadId = original?.thread_id || params.originalEmailId;

	// Append quoted original message
	const quotedBlock = original
		? buildQuotedReplyBlock({
				date: original.date,
				sender: original.sender || params.to,
				body: original.body ?? undefined,
			})
		: "";
	const bodyHtml = processedBody + quotedBlock;

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: bodyHtml,
			in_reply_to: params.originalEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			originalEmailId: params.originalEmailId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : bodyHtml,
		},
	};
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		/** Optional in_reply_to for create_draft style */
		in_reply_to?: string;
		/** Optional thread_id for create_draft style */
		thread_id?: string;
	},
): Promise<
	| { status: string; draftId: string; threadId?: string; message: string; draft?: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Resolve thread ID
	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
		resolvedThreadId = original?.thread_id || params.in_reply_to;
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId;
	}

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			date: new Date().toISOString(),
			body: processedBody,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		threadId: resolvedThreadId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : processedBody,
		},
	};
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	env: Env,
	mailboxId: string,
	params: {
		draftId: string;
		to?: string;
		subject?: string;
		bodyHtml?: string;
	},
): Promise<
	| { status: string; newDraftId: string; oldDraftId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null;
	if (!oldDraft) {
		return { error: "Draft not found" };
	}

	// Verify the body BEFORE deleting the old draft to prevent data loss
	const newDraftId = crypto.randomUUID();
	const rawBody = params.bodyHtml ?? oldDraft.body ?? "";
	const verifiedBody = await verifyDraft(env.AI, rawBody);

	if (!verifiedBody) {
		return { error: "Draft verification failed — keeping existing draft unchanged. Please try again." };
	}

	await stub.deleteEmail(params.draftId);
	await stub.createEmail(
		Folders.DRAFT,
		{
			id: newDraftId,
			subject: params.subject ?? oldDraft.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to ?? oldDraft.recipient).toLowerCase(),
			date: new Date().toISOString(),
			body: verifiedBody,
			in_reply_to: oldDraft.in_reply_to || null,
			email_references: oldDraft.email_references || null,
			thread_id: oldDraft.thread_id || newDraftId,
		},
		[],
	);

	return {
		status: "draft_updated",
		newDraftId,
		oldDraftId: params.draftId,
		message: "Draft updated in Drafts folder.",
	};
}

// ── mark_email_read ────────────────────────────────────────────────

export async function toolMarkEmailRead(
	env: Env,
	mailboxId: string,
	emailId: string,
	read: boolean,
) {
	const stub = getMailboxStub(env, mailboxId);
	await stub.updateEmail(emailId, { read });
	return { status: "updated", emailId, read };
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	folderId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const success = await stub.moveEmail(emailId, folderId);
	if (success) {
		return { status: "moved", emailId, folder: folderId };
	}
	if (!isSystemFolder(folderId)) {
		return { error: "Custom folders are labels now. Use label_conversation." };
	}
	return { error: "Failed to move email" };
}

// ── list_labels ────────────────────────────────────────────────────

export async function toolListLabels(env: Env) {
	const labels = await getMailIndexStub(env).listLabels();
	return { labels: labels.map(({ id, name, color, count }) => ({ id, name, color, conversations: count })) };
}

// ── create_label ───────────────────────────────────────────────────

/**
 * Create a label shared by every mailbox. A label with the same name (any
 * case) is returned as it is, so the call is safe to repeat.
 */
export async function toolCreateLabel(env: Env, params: { name: string; color?: string }) {
	const index = getMailIndexStub(env);
	const labels = await index.listLabels();
	const name = params.name.trim();
	const existing = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
	if (existing) return { status: "exists", label: { id: existing.id, name: existing.name, color: existing.color } };
	const color = params.color ?? LABEL_COLORS[labels.length % LABEL_COLORS.length].bg;
	const result = await index.createLabel({ name, color });
	if ("error" in result && result.error) return { error: result.error };
	const label = (result as { label: { id: string; name: string; color: string } }).label;
	return { status: "created", label: { id: label.id, name: label.name, color: label.color } };
}

function findLabel<T extends { id: string; name: string }>(labels: T[], ref: string): T | undefined {
	const r = ref.trim().toLowerCase();
	return labels.find((l) => l.id === ref.trim() || l.name.toLowerCase() === r);
}

// ── rename_label ───────────────────────────────────────────────────

/** Rename a label, named by id or name. Conversations keep it. */
export async function toolRenameLabel(env: Env, params: { label: string; name: string }) {
	const index = getMailIndexStub(env);
	const label = findLabel(await index.listLabels(), params.label);
	if (!label) return { error: `Unknown label: ${params.label}. Use list_labels to see labels.` };
	const result = await index.updateLabel(label.id, { name: params.name.trim() });
	if ("error" in result && result.error) return { error: result.error };
	const updated = (result as { label: { id: string; name: string } | null }).label;
	if (!updated) return { error: `Unknown label: ${params.label}.` };
	return { status: "renamed", from: label.name, label: { id: updated.id, name: updated.name } };
}

// ── delete_label ───────────────────────────────────────────────────

/** Delete a label, named by id or name: it comes off every conversation, then the label goes. */
export async function toolDeleteLabel(env: Env, params: { label: string }) {
	const index = getMailIndexStub(env);
	const label = findLabel(await index.listLabels(), params.label);
	if (!label) return { error: `Unknown label: ${params.label}. Use list_labels to see labels.` };
	const result = await index.deleteLabel(label.id);
	if (!result) return { error: `Unknown label: ${params.label}.` };
	if (!result.deleted) return { error: `Could not remove ${label.name} from every conversation; it was kept.`, failed: result.failed };
	return { status: "deleted", label: label.name, conversations: label.count };
}

// ── label_conversation ─────────────────────────────────────────────

/**
 * Add or remove labels on the whole conversation that holds an email, and
 * optionally archive it. Labels are named by id or name; unknown ones are refused.
 */
export async function toolLabelConversation(
	env: Env,
	mailboxId: string,
	emailId: string,
	params: { add?: string[]; remove?: string[]; archive?: boolean },
) {
	const index = getMailIndexStub(env);
	const labels = await index.listLabels();
	const resolve = (ref: string) =>
		labels.find((l) => l.id === ref || l.name.toLowerCase() === ref.trim().toLowerCase());
	const unknown = [...(params.add ?? []), ...(params.remove ?? [])].filter((ref) => !resolve(ref));
	if (unknown.length > 0) {
		return { error: `Unknown label: ${unknown.join(", ")}. Use list_labels to see labels, or create_label to make one.` };
	}
	const threadKey = await index.threadKeyOf(mailboxId, emailId);
	if (!threadKey) return { error: "Email not found in the mail index", emailId };

	const target = { threadKeys: [threadKey], view: "all" };
	const done: string[] = [];
	for (const [refs, type] of [[params.add ?? [], "label_add"], [params.remove ?? [], "label_remove"]] as const) {
		for (const ref of refs) {
			const label = resolve(ref)!;
			const result = await index.bulk(target, { type, labelId: label.id });
			const failure = "failed" in result ? result.failed?.[0] : undefined;
			if (failure) return { error: failure.error };
			done.push(`${type === "label_add" ? "added" : "removed"} ${label.name}`);
		}
	}
	const added = (params.add ?? []).map((ref) => resolve(ref)!.id);
	if (added.length > 0) await index.markLabelsAuto(added);
	if (params.archive) {
		await index.bulk({ threadKeys: [threadKey], view: "inbox" }, { type: "archive" });
		done.push("archived");
	}
	return { status: "updated", emailId, changes: done };
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(
	env: Env,
	mailboxId: string,
	draftId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(draftId)) as { folder_id?: string } | null;
	if (!email) {
		return { error: "Draft not found" };
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" };
	}
	await stub.deleteEmail(draftId);
	return { status: "discarded", draftId };
}

// ── delete_email ───────────────────────────────────────────────────

/** Moves an email to Trash. Tools never delete permanently. */
export async function toolDeleteEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(emailId)) as { folder_id?: string } | null;
	if (!email) {
		return { error: "Email not found", emailId };
	}
	if (email.folder_id === Folders.TRASH) {
		return { status: "already_in_trash", emailId };
	}
	await stub.moveEmail(emailId, Folders.TRASH);
	return { status: "moved_to_trash", emailId };
}
