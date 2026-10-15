// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Auto-draft reads untrusted inbound mail, so it is kept narrow:
 *
 * - Before the model runs, the new email and its whole thread are read once
 *   and every field the model will see (sender, sender name, recipient,
 *   subject, full body of each message) is scanned for prompt injection. Any
 *   doubt (an injection, an unclear answer, a failed scan, a failed read)
 *   skips the draft with a reason.
 * - The model gets three tools: get_email and get_thread return that scanned
 *   snapshot and nothing else, and draft_reply replies to the new email, to
 *   its Reply-To or else its sender. The model can't change the recipient.
 *
 * The chat agent's tools are in ./index.ts.
 */
import { z } from "zod";
import { getReplyAddresses } from "../../app/lib/reply";
import { scanForInjection } from "../lib/ai";
import { Folders } from "../../shared/folders";
import { logged } from "../lib/activity";
import { stripHtmlToText, textToHtml } from "../lib/email-helpers";
import { parseSender } from "../lib/message-meta";
import { HeaderValueSchema } from "../lib/schemas";
import type { EmailFull } from "../lib/schemas";
import { type Agent, agentPrompt, findAgent } from "../lib/agents";
import { toolDraftReply } from "../lib/tools";
import type { MailboxStore } from "../store/types";
import type { Sql } from "../store/sql";
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

/** What the model may see of one message. Every field is scanned. */
export interface AutoDraftMessage {
	id: string;
	date: string;
	folder_id: string | null;
	sender: string;
	sender_name: string;
	recipient: string;
	subject: string;
	body_text: string;
}

export interface AutoDraftContext {
	email: AutoDraftMessage;
	/** The thread oldest first, the new email included. */
	thread: AutoDraftMessage[];
	replyTo: string;
}

/** Where an auto-drafted reply goes: the Reply-To addresses, else the sender. Empty when neither is known. */
export function autoDraftRecipient(email: { sender?: string | null; raw_headers?: string | null }): string {
	return getReplyAddresses({ sender: email.sender ?? "", raw_headers: email.raw_headers })
		.map((a) => a.trim().toLowerCase())
		.filter(Boolean)
		.join(", ");
}

export function autoDraftMessage(email: EmailFull): AutoDraftMessage {
	return {
		id: email.id,
		date: email.date,
		folder_id: email.folder_id ?? null,
		sender: (email.sender ?? "").toLowerCase(),
		sender_name: parseSender(email.sender, email.raw_headers).name,
		recipient: email.recipient ?? "",
		subject: email.subject ?? "",
		body_text: email.body ? stripHtmlToText(email.body) : "",
	};
}

/** The text scanned for injection: every field of every message the model can see. */
export function autoDraftScanText(thread: readonly AutoDraftMessage[]): string {
	return thread
		.map((m) => `From: ${m.sender_name} <${m.sender}>\nTo: ${m.recipient}\nSubject: ${m.subject}\n\n${m.body_text}`)
		.join("\n\n---\n\n");
}

type ThreadReader = {
	getEmail(id: string): Promise<unknown>;
	getThreadEmails(threadId: string): Promise<unknown>;
};

/**
 * Read the new email and its thread, and scan them. Returns the snapshot the
 * model may use, or the reason auto-draft is skipped.
 */
export async function prepareAutoDraft(
	ai: Ai,
	store: ThreadReader,
	target: { emailId: string; threadId: string },
): Promise<{ ok: true; context: AutoDraftContext } | { ok: false; reason: string }> {
	let raw: EmailFull | null;
	let threadRaw: EmailFull[];
	try {
		raw = (await store.getEmail(target.emailId)) as EmailFull | null;
		threadRaw = ((await store.getThreadEmails(target.threadId)) as EmailFull[] | null) ?? [];
	} catch (e) {
		return { ok: false, reason: `could not read the email or its thread: ${(e as Error).message}` };
	}
	if (!raw) return { ok: false, reason: "email not found" };
	const replyTo = autoDraftRecipient(raw);
	if (!replyTo) return { ok: false, reason: "no address to reply to" };

	const email = autoDraftMessage(raw);
	const thread = threadRaw.map(autoDraftMessage);
	if (!thread.some((m) => m.id === email.id)) thread.push(email);
	thread.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

	const scan = await scanForInjection(ai, autoDraftScanText(thread));
	if (!scan.ok) return { ok: false, reason: scan.reason };
	return { ok: true, context: { email, thread, replyTo } };
}

/** Characters of each earlier message quoted in the prompt. get_thread has them in full. */
const PROMPT_HISTORY_CHARS = 500;

export function autoDraftPrompt(mailboxId: string, threadId: string, context: AutoDraftContext, agents: readonly Agent[] = []): string {
	const { email, thread } = context;
	const from = email.sender_name ? `${email.sender_name} <${email.sender}>` : email.sender;
	let prompt = `A new email just arrived. Draft an appropriate response using draft_reply.

Email details:
- Mailbox: ${mailboxId}
- Email ID: ${email.id}
- From: ${from}
- Subject: ${email.subject}
- Thread ID: ${threadId}

Email body:
${email.body_text || "(empty)"}`;

	const earlier = thread.filter((m) => m.id !== email.id);
	if (earlier.length > 0) {
		const history = thread
			.map((m) => `[${m.date}] ${m.sender} → ${m.recipient} (${m.folder_id}): ${m.body_text.substring(0, PROMPT_HISTORY_CHARS)}`)
			.join("\n\n");
		prompt += `\n\nFull thread history (${threadId}):\n${history}`;
	} else {
		prompt += `\n\nThis is the first message in the thread (no prior conversation).`;
	}
	prompt += `\n\nBased on the email content and thread context above, draft a reply using draft_reply. If you need more context, use get_thread.`;
	const section = agentPrompt(agents);
	if (section) prompt += `\n\n${section}`;
	return prompt;
}

export function createAutoDraftTools(
	env: Env,
	target: AutoDraftTarget,
	context: Pick<AutoDraftContext, "thread">,
	draftReply: typeof toolDraftReply = toolDraftReply,
	options: { agents?: readonly Agent[]; onDraft?: (draftId: string, agent: string | null) => void } = {},
) {
	const { mailboxId, emailId, threadId, to } = target;
	const agents = options.agents ?? [];
	return {
		get_email: defineTool({
			description: "Get an email in this conversation with its full body. Only the new email and the emails in its thread can be read.",
			parameters: z.object({
				emailId: z.string().describe("The email ID to retrieve"),
			}),
			execute: async ({ emailId: id }): Promise<unknown> =>
				context.thread.find((m) => m.id === id) ?? { error: "Email not found in this conversation" },
		}),
		get_thread: defineTool({
			description: "Get every email in this conversation, oldest first.",
			parameters: z.object({}),
			execute: async (): Promise<unknown> => ({ thread_id: threadId, message_count: context.thread.length, messages: context.thread }),
		}),
		draft_reply: defineTool({
			description:
				"Draft a reply to the new email and save it to the Drafts folder. It goes to the email's sender. Write the body as plain text, no HTML tags.",
			parameters: z.object({
				subject: HeaderValueSchema.describe("Subject line (usually 'Re: ...')"),
				body: z.string().describe("The plain text body of the reply. No HTML, just write normally."),
				...(agents.length > 0
					? { agent: z.string().optional().describe("The name of the agent whose job you followed. Leave out if none fits.") }
					: {}),
			}),
			execute: async ({ subject, body, agent }: { subject: string; body: string; agent?: string }): Promise<unknown> => {
				const chosen = findAgent(agents, agent)?.name ?? null;
				const result = await draftReply(env, mailboxId, {
					originalEmailId: emailId,
					to,
					subject,
					body,
					isPlainText: true,
					runVerifyDraft: true,
					notes: { origin: "auto-draft", agent: chosen, instructions: [] },
				});
				if ("draftId" in result) options.onDraft?.(result.draftId, chosen);
				return result;
			},
		}),
	};
}

/**
 * Save the model's reply text as the draft when it answered without calling
 * draft_reply. Logged as a draft_reply call so it shows in Console > Activity.
 * `text` has been through verifyDraft. `onDraft` gets the id as soon as the
 * draft exists, so a later error still leaves the run drafted.
 */
export async function saveTextDraft(
	stub: Pick<MailboxStore, "createEmail" | "setDraftNotes">,
	sql: Sql,
	target: AutoDraftTarget,
	subject: string,
	text: string,
	onDraft: (draftId: string) => void,
): Promise<void> {
	const reSubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
	const args = { to: target.to, subject: reSubject };
	await logged(sql, { actor: "auto-draft", bound: target.mailboxId }, "draft_reply", args, async () => {
		const id = crypto.randomUUID();
		await stub.createEmail(
			Folders.DRAFT,
			{
				id,
				subject: reSubject,
				sender: target.mailboxId.toLowerCase(),
				recipient: target.to,
				date: new Date().toISOString(),
				// verifyDraft may return plain text or HTML. Only plain text is wrapped.
				body: /<[a-z][\s\S]*>/i.test(text) ? text : textToHtml(text),
				in_reply_to: target.emailId,
				email_references: null,
				thread_id: target.threadId,
			},
			[],
		);
		onDraft(id);
		await stub.setDraftNotes(id, { origin: "auto-draft", agent: null, instructions: [] });
		return { draftId: id };
	});
}
