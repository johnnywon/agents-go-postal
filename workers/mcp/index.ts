// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HeaderValueSchema } from "../lib/schemas";
import {
	toolDeleteLabel,
	toolRenameLabel,
	toolCreateLabel,
	toolListMailboxes,
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
	toolDeleteEmail,
	toolSendDraft,
	toolMarkEmailRead,
	toolMoveEmail,
	toolListLabels,
	toolListShortcuts,
	toolSetShortcut,
	toolResetShortcuts,
	SHORTCUT_TOOL_DESCRIPTIONS,
	toolLabelConversation,
	toolLabelMatching,
	toolSearchAllMail,
	LABEL_MATCHING_MAX,
	SEARCH_HELP,
} from "../lib/tools";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "../../shared/folders";
import { DATE_TOKENS, VIEWS } from "../lib/mail-index-sql";
import { mailStore } from "../store";
import type { Env } from "../types";

/** Wrap a plain result object into MCP content format. */
function mcpText(result: unknown) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(result, null, 2) },
		],
	};
}

/** Wrap an error string into MCP error format. */
function mcpError(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true as const,
	};
}

/**
 * Wrap a result that may contain an `error` field into MCP format,
 * automatically setting isError when appropriate.
 */
function mcpResult(result: Record<string, unknown>) {
	if ("error" in result) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			isError: true as const,
		};
	}
	return mcpText(result);
}

/**
 * EmailMCP — exposes email tools over the Model Context Protocol.
 *
 * Clients (ProtoAgent, Claude Code, Cursor, etc.) connect to the
 * `/mcp` endpoint and can list mailboxes, read/search emails,
 * draft and send mail, and manage labels and folders.
 */
export class EmailMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "agentic-inbox",
		version: "1.0.0",
	});

	async init() {
		const env = this.env;

		/**
		 * Verify a mailbox exists before operating on it.
		 * Returns an MCP error response if the mailbox is not found, or null if valid.
		 */
		const verifyMailbox = async (mailboxId: string) => {
			if (!(await mailStore(env).mailboxes.exists(mailboxId))) {
				return mcpError(`Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`);
			}
			return null;
		};

		// ── list_mailboxes ─────────────────────────────────────────
		this.server.tool(
			"list_mailboxes",
			"List all available mailboxes",
			{},
			async () => {
				const result = await toolListMailboxes(env);
				return mcpText(result);
			},
		);

		// ── list_emails ────────────────────────────────────────────
		this.server.tool(
			"list_emails",
			"List emails in a mailbox folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
			{
				mailboxId: z
					.string()
					.describe("The mailbox email address (e.g. user@example.com)"),
				folder: z
					.string()
					.default(Folders.INBOX)
					.describe(FOLDER_TOOL_DESCRIPTION),
				limit: z
					.number()
					.default(20)
					.describe("Maximum number of emails to return"),
				page: z
					.number()
					.default(1)
					.describe("Page number for pagination"),
			},
			async ({ mailboxId, folder, limit, page }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolListEmails(env, mailboxId, { folder, limit, page });
				return mcpText(result);
			},
		);

		// ── get_email ──────────────────────────────────────────────
		this.server.tool(
			"get_email",
			"Get a single email with its full body content. Use this to read the actual content of an email.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to retrieve"),
			},
			async ({ mailboxId, emailId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolGetEmail(env, mailboxId, emailId);
				if ("error" in result) {
					return {
						content: [{ type: "text" as const, text: "Email not found" }],
						isError: true,
					};
				}
				return mcpText(result);
			},
		);

		// ── get_thread ─────────────────────────────────────────────
		this.server.tool(
			"get_thread",
			"Get all emails in a conversation thread. Returns all messages sorted chronologically.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				threadId: z
					.string()
					.describe("The thread_id to retrieve all messages for"),
			},
			async ({ mailboxId, threadId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolGetThread(env, mailboxId, threadId);
				return mcpText(result);
			},
		);

		// ── search_emails ──────────────────────────────────────────
		this.server.tool(
			"search_emails",
			"Search one address's conversations. Same search and results as search_all_mail, limited to that address.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				query: z.string().describe(`Search text. ${SEARCH_HELP}`),
				folder: z
					.string()
					.optional()
					.describe("Optional folder or view to restrict the search to"),
			},
			async ({ mailboxId, query, folder }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSearchEmails(env, mailboxId, { query, folder });
				return mcpText(result);
			},
		);

		// ── draft_reply ────────────────────────────────────────────
		this.server.tool(
			"draft_reply",
			"Draft a reply to an email and save it to the Drafts folder. Use send_draft to send it.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: HeaderValueSchema.describe("Subject line (usually 'Re: ...')"),
				bodyHtml: z
					.string()
					.describe("The HTML body of the reply"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDraftReply(env, mailboxId, {
					originalEmailId,
					to,
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
				});
				return mcpResult(result);
			},
		);

		// ── create_draft ───────────────────────────────────────────
		this.server.tool(
			"create_draft",
			"Create a new draft email. Can be a new email or a reply draft.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				to: z
					.string()
					.optional()
					.describe("Recipient email address (optional for early drafts)"),
				subject: HeaderValueSchema.describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the draft"),
				in_reply_to: HeaderValueSchema
					.optional()
					.describe("The ID of the email this draft is replying to (optional)"),
				thread_id: HeaderValueSchema
					.optional()
					.describe("Thread ID to attach this draft to (optional)"),
			},
			async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDraftEmail(env, mailboxId, {
					to: to || "",
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
					in_reply_to,
					thread_id,
				});
				if ("error" in result) {
					return mcpResult(result);
				}
				// Map the response to match the original create_draft output shape
				return mcpText({
					status: "draft_created",
					draftId: result.draftId,
					threadId: result.threadId,
					message: "Draft created in Drafts folder.",
				});
			},
		);

		// ── update_draft ───────────────────────────────────────────
		this.server.tool(
			"update_draft",
			"Update an existing draft. The draft is replaced: the result's newDraftId is its ID from now on, and the old draftId no longer works.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				draftId: z.string().describe("The ID of the draft to update"),
				to: z
					.string()
					.optional()
					.describe("Updated recipient email address"),
				subject: HeaderValueSchema.optional().describe("Updated subject line"),
				bodyHtml: z.string().optional().describe("Updated HTML body"),
			},
			async ({ mailboxId, draftId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolUpdateDraft(env, mailboxId, {
					draftId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					if (result.error === "Draft not found") {
						return {
							content: [{ type: "text" as const, text: "Draft not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── send_draft ─────────────────────────────────────────────
		this.server.tool(
			"send_draft",
			"Send a saved draft now and remove it from Drafts. A reply draft is sent in its thread. A draft that was already sent returns \"Draft not found\" and is not sent again.",
			{
				mailboxId: z.string().describe("The mailbox the draft is in. It is sent from that address."),
				draftId: z.string().describe("The ID of the draft to send"),
			},
			async ({ mailboxId, draftId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				return mcpResult(await toolSendDraft(env, mailboxId, draftId));
			},
		);

		// ── delete_email ───────────────────────────────────────────
		this.server.tool(
			"delete_email",
			"Move an email to Trash.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to move to Trash"),
			},
			async ({ mailboxId, emailId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDeleteEmail(env, mailboxId, emailId);
				return mcpResult(result);
			},
		);

		// ── list_labels ────────────────────────────────────────────
		this.server.tool(
			"list_labels",
			"List labels with their ids, colours and conversation counts. Labels are tags shared by every mailbox.",
			{},
			async () => mcpText(await toolListLabels(env)),
		);

		// ── Keyboard shortcuts ─────────────────────────────────────
		this.server.tool("list_shortcuts", SHORTCUT_TOOL_DESCRIPTIONS.list, {}, async () => mcpText(await toolListShortcuts(env)));
		this.server.tool(
			"set_shortcut",
			SHORTCUT_TOOL_DESCRIPTIONS.set,
			{
				shortcut: z.string().describe(SHORTCUT_TOOL_DESCRIPTIONS.shortcut),
				keys: z.array(z.string()).max(2).describe(SHORTCUT_TOOL_DESCRIPTIONS.keys),
			},
			async ({ shortcut, keys }) => mcpResult(await toolSetShortcut(env, { shortcut, keys })),
		);
		this.server.tool(
			"reset_shortcuts",
			SHORTCUT_TOOL_DESCRIPTIONS.reset,
			{ shortcut: z.string().optional().describe(SHORTCUT_TOOL_DESCRIPTIONS.shortcut) },
			async ({ shortcut }) => mcpResult(await toolResetShortcuts(env, { shortcut })),
		);

		// ── create_label ───────────────────────────────────────────
		this.server.tool(
			"create_label",
			"Create a label shared by every mailbox. If a label with that name exists, it is returned instead. Then apply it with label_conversation.",
			{
				name: z.string().min(1).max(60).describe("Label name, e.g. Receipts"),
			},
			async ({ name }) => mcpResult(await toolCreateLabel(env, { name })),
		);

		// ── rename_label ───────────────────────────────────────────
		this.server.tool(
			"rename_label",
			"Rename a label. Conversations keep it under the new name.",
			{
				label: z.string().describe("The label's id or current name"),
				name: z.string().min(1).max(60).describe("The new name"),
			},
			async ({ label, name }) => mcpResult(await toolRenameLabel(env, { label, name })),
		);

		// ── delete_label ───────────────────────────────────────────
		this.server.tool(
			"delete_label",
			"Delete a label. It is removed from every conversation that carries it; the mail itself stays. This cannot be undone.",
			{ label: z.string().describe("The label's id or name") },
			async ({ label }) => mcpResult(await toolDeleteLabel(env, { label })),
		);

		// ── label_conversation ─────────────────────────────────────
		this.server.tool(
			"label_conversation",
			"Add or remove labels on the conversation that holds an email. Labeling leaves the conversation where it is unless archive is true.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("Any email ID in the conversation"),
				add: z.array(z.string()).optional().describe("Label ids or names to add"),
				remove: z.array(z.string()).optional().describe("Label ids or names to remove"),
				archive: z.boolean().optional().describe("Also move the conversation's Inbox mail to Archive"),
			},
			async ({ mailboxId, emailId, add, remove, archive }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				return mcpResult(await toolLabelConversation(env, mailboxId, emailId, { add, remove, archive }));
			},
		);

		// ── search_all_mail / label_matching ──────────────────────
		const mailSearch = {
			query: z.string().optional().describe(`Search text. ${SEARCH_HELP}`),
			from: z.array(z.string()).optional().describe("Sender addresses or domains"),
			to: z.array(z.string()).optional().describe("Your addresses or domains the mail was delivered to. Leave out for every address."),
			label: z.array(z.string()).optional().describe("Only conversations that already carry these labels (ids or names)"),
			folder: z.enum(VIEWS).optional().describe("Folder to search. Defaults to all, which covers every folder except Spam and Trash; anywhere includes them."),
			unread: z.boolean().optional().describe("true for unread only, false for read only"),
			starred: z.boolean().optional(),
			hasAttachment: z.boolean().optional(),
			date: z.enum(DATE_TOKENS).optional().describe("today, yesterday, 7d, 30d or older"),
		};
		this.server.tool(
			"search_all_mail",
			"Search conversations across every address at once. Each result gives its mailboxId and emailId.",
			{ ...mailSearch, limit: z.number().int().min(1).max(50).optional() },
			async (search) => mcpResult(await toolSearchAllMail(env, search)),
		);
		this.server.tool(
			"label_matching",
			`Add or remove labels on every conversation that matches a search, across all addresses, in one call. Up to ${LABEL_MATCHING_MAX} conversations.`,
			{
				...mailSearch,
				add: z.array(z.string()).optional().describe("Label ids or names to add"),
				remove: z.array(z.string()).optional().describe("Label ids or names to remove"),
				archive: z.boolean().optional().describe("Also move the matching Inbox mail to Archive"),
			},
			async ({ add, remove, archive, ...search }) => mcpResult(await toolLabelMatching(env, search, { add, remove, archive })),
		);

		// ── mark_email_read ────────────────────────────────────────
		this.server.tool(
			"mark_email_read",
			"Mark an email as read or unread.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				read: z.boolean().describe("true to mark as read, false for unread"),
			},
			async ({ mailboxId, emailId, read }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolMarkEmailRead(env, mailboxId, emailId, read);
				return mcpText(result);
			},
		);

		// ── move_email ─────────────────────────────────────────────
		this.server.tool(
			"move_email",
			"Move an email to a system folder (inbox, archive, spam, trash). Custom folders are labels; use label_conversation.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				folderId: z
					.string()
					.describe(MOVE_FOLDER_TOOL_DESCRIPTION),
			},
			async ({ mailboxId, emailId, folderId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolMoveEmail(env, mailboxId, emailId, folderId);
				if ("error" in result) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ error: result.error }),
							},
						],
						isError: true,
					};
				}
				return mcpText(result);
			},
		);
	}
}
