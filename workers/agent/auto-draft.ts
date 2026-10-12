// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tools for auto-draft. Auto-draft reads untrusted inbound mail, so it gets
 * three tools and nothing else: read the new email, read its thread, and draft
 * a reply to it. The reply goes to the message's Reply-To, or its sender, and
 * the model can't change that. The chat agent's tools are in ./index.ts.
 */
import { z } from "zod";
import { getReplyAddresses } from "../../app/lib/reply";
import { toolDraftReply, toolGetEmail, toolGetThread } from "../lib/tools";
import type { Env } from "../types";
import { defineTool } from "./tool-def";

export const AUTO_DRAFT_TOOLS = ["get_email", "get_thread", "draft_reply"] as const;

/** The inbound email auto-draft answers, and who the reply goes to. */
export interface AutoDraftTarget {
	mailboxId: string;
	emailId: string;
	threadId: string;
	/** Fixed recipient list, from autoDraftRecipient. */
	to: string;
}

/** Where an auto-drafted reply goes: the Reply-To addresses, else the sender. Empty when neither is known. */
export function autoDraftRecipient(email: { sender?: string | null; raw_headers?: string | null }): string {
	return getReplyAddresses({ sender: email.sender ?? "", raw_headers: email.raw_headers })
		.map((a) => a.trim().toLowerCase())
		.filter(Boolean)
		.join(", ");
}

type Impl = {
	getEmail: typeof toolGetEmail;
	getThread: typeof toolGetThread;
	draftReply: typeof toolDraftReply;
};

const DEFAULT_IMPL: Impl = { getEmail: toolGetEmail, getThread: toolGetThread, draftReply: toolDraftReply };

export function createAutoDraftTools(env: Env, target: AutoDraftTarget, impl: Impl = DEFAULT_IMPL) {
	const { mailboxId, emailId, threadId, to } = target;
	const threadIds = async (): Promise<Set<string>> => {
		const thread = (await impl.getThread(env, mailboxId, threadId)) as { messages?: { id: string }[] };
		return new Set((thread.messages ?? []).map((m) => m.id));
	};
	return {
		get_email: defineTool({
			description: "Get an email in this conversation with its full body. Only the new email and the emails in its thread can be read.",
			parameters: z.object({
				emailId: z.string().describe("The email ID to retrieve"),
			}),
			execute: async ({ emailId: id }): Promise<unknown> => {
				if (id !== emailId && !(await threadIds()).has(id)) return { error: "Email not found in this conversation" };
				return impl.getEmail(env, mailboxId, id);
			},
		}),
		get_thread: defineTool({
			description: "Get every email in this conversation, oldest first.",
			parameters: z.object({}),
			execute: async (): Promise<unknown> => impl.getThread(env, mailboxId, threadId),
		}),
		draft_reply: defineTool({
			description:
				"Draft a reply to the new email and save it to the Drafts folder. It goes to the email's sender. Write the body as plain text, no HTML tags.",
			parameters: z.object({
				subject: z.string().describe("Subject line (usually 'Re: ...')"),
				body: z.string().describe("The plain text body of the reply. No HTML, just write normally."),
			}),
			execute: async ({ subject, body }): Promise<unknown> =>
				impl.draftReply(env, mailboxId, {
					originalEmailId: emailId,
					to,
					subject,
					body,
					isPlainText: true,
					runVerifyDraft: true,
				}),
		}),
	};
}
