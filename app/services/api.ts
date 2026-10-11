// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { BulkAction } from "~/lib/bulk-optimistic";
import type { CombinedInboxResponse, Email, Folder, Mailbox } from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

export interface Conversation {
	thread_key: string;
	mailbox_id: string;
	email_id: string;
	message_id: string | null;
	state: string;
	date: string;
	sender_addr: string;
	sender_name: string;
	subject: string;
	snippet: string;
	unread: boolean;
	starred: boolean;
	has_attachment: boolean;
	can_unsubscribe: boolean;
	labels: string[];
	thread_count: number;
	thread_unread_count: number;
	participants: string[];
	has_draft: boolean;
	also_in: string[];
}

export interface MailPage {
	conversations: Conversation[];
	nextCursor: string | null;
	total?: number;
	unread?: number;
	indexing: { done: number; total: number } | null;
}

export interface FacetValue {
	value: string;
	count: number;
	name?: string;
}

export interface MailFacets {
	address: FacetValue[];
	from: { domains: FacetValue[]; addresses: FacetValue[]; more: boolean };
	label: FacetValue[];
	date: Record<"today" | "yesterday" | "7d" | "30d" | "older", number>;
	status: Record<"unread" | "read" | "starred" | "attachment" | "unsubscribe", number>;
}

export interface Label {
	id: string;
	name: string;
	color: string;
	position: number;
	count: number;
	/** The agent has applied this label (through the chat agent or MCP). */
	auto?: boolean;
}

export interface ScheduledSend {
	mailboxId: string;
	emailId: string;
	sendAt: string;
	error: string | null;
}

export interface ScheduleRequest {
	sendAt: string;
	draft_id?: string;
	mode: "new" | "reply" | "reply-all" | "forward";
	original_id?: string;
	email: unknown;
}

export type BulkTarget =
	| { threadKeys: string[]; view: string }
	| { filter: string; asOf: string; expectedCount: number };

export interface BulkResult {
	affected: number;
	undoId: string;
	failed: { mailboxId: string; error: string }[];
}

export interface BulkJobStarted {
	jobId: string;
	total: number;
	undoId: string;
}

export interface BulkJob {
	id: string;
	total: number;
	done: number;
	affected: number;
	failed: { mailboxId: string; error: string }[];
	undoId: string;
	finishedAt: string | null;
}

export interface TrashCount {
	messages: number;
	conversations: number;
}

export interface EmptyTrashResult {
	deleted: number;
	failed: { mailboxId: string; error: string }[];
}

export interface FolderImportPlan {
	labels: { id: string; name: string; exists: boolean; folders: number; messages: number }[];
	mailboxes: { mailboxId: string; imported: boolean; folders: { folderId: string; name: string; count: number; labelId: string }[] }[];
	totals: { mailboxes: number; folders: number; messages: number };
}

export interface FolderImportResult {
	backup: string;
	plan: FolderImportPlan;
	results: { mailboxId: string; folderId: string; labelId: string; labeled: number; archived: number; error?: string }[];
}

export interface IndexCounts {
	states: Record<string, number>;
	unread: number;
	starred: number;
	total: number;
}

export interface IndexStatusResponse {
	messages: number;
	probe: string | null;
	job: {
		generation: number;
		mailboxes: string[];
		position: number;
		startedAt: string;
		finishedAt: string | null;
		error: string | null;
	} | null;
	mailboxes: {
		mailboxId: string;
		error?: string;
		source?: { mailboxId: string | null; seq: number; pending: number; counts: IndexCounts; inboxConversations: number };
		index: (IndexCounts & { inboxConversations: number; appliedSeq: number }) | null;
	}[];
}

export type AgentProvider = "workers-ai" | "openrouter";
export interface AgentModelView {
	provider: AgentProvider;
	model: string;
	keySet: boolean;
	keyHint: string;
	defaultModel: string;
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[]; mailUi: "postal" | "unified" | "classic"; autoDraft?: boolean }>("/api/v1/config"),

	// Agent model
	getAgentModel: () => get<AgentModelView>("/api/v1/agent-model"),
	updateAgentModel: (body: { provider?: AgentProvider; model?: string; apiKey?: string }) =>
		put<AgentModelView>("/api/v1/agent-model", body),
	testAgentModel: (body: { model?: string; apiKey?: string }) =>
		post<{ ok: boolean; reply?: string; error?: string }>("/api/v1/agent-model/test", body),
	listAgentModels: () => get<{ models: { id: string; name: string }[] }>("/api/v1/agent-model/models"),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Emails
	getCombinedInbox: (cursor?: string, opts?: { signal?: AbortSignal }) =>
		get<CombinedInboxResponse>("/api/v1/inbox", {
			params: cursor ? { cursor } : undefined,
			signal: opts?.signal,
		}),
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) => post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),

	// Scheduled send
	scheduleSend: (mailboxId: string, request: ScheduleRequest) =>
		post<{ id: string; sendAt: string }>(`/api/v1/mailboxes/${mailboxId}/scheduled`, request),
	getScheduled: () => get<ScheduledSend[]>("/api/v1/mail/scheduled"),
	cancelScheduled: (mailboxId: string, emailId: string) =>
		del<{ status: string }>(`/api/v1/mailboxes/${mailboxId}/scheduled/${encodeURIComponent(emailId)}`),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Unified mail
	getMail: (params: URLSearchParams, opts?: { signal?: AbortSignal }) =>
		request<MailPage>(`/api/v1/mail?${params}`, { method: "GET", signal: opts?.signal }),
	getMailFacets: (params: URLSearchParams, opts?: { signal?: AbortSignal }) =>
		request<MailFacets>(`/api/v1/mail/facets?${params}`, { method: "GET", signal: opts?.signal }),
	getMailFolders: () => get<{ view: string; count: number }[]>("/api/v1/mail/folders"),

	// Bulk actions
	bulk: (target: BulkTarget, action: BulkAction) => post<BulkResult | BulkJobStarted>("/api/v1/mail/bulk", { target, action }),
	undoBulk: (undoId: string) => post<{ affected: number }>("/api/v1/mail/bulk/undo", { undoId }),
	getBulkJob: (jobId: string) => get<BulkJob>(`/api/v1/mail/bulk/jobs/${encodeURIComponent(jobId)}`),
	getTrashCount: () => get<TrashCount>("/api/v1/mail/trash"),
	emptyTrash: (expectedCount: number) => post<EmptyTrashResult | BulkJobStarted>("/api/v1/mail/empty-trash", { expectedCount }),

	// Labels
	getLabels: () => get<Label[]>("/api/v1/labels"),
	createLabel: (input: { name: string; color?: string }) => post<Label>("/api/v1/labels", input),
	updateLabel: (id: string, input: { name?: string; color?: string }) => put<Label>(`/api/v1/labels/${encodeURIComponent(id)}`, input),
	deleteLabel: (id: string) => del<{ deleted: boolean; affected: number }>(`/api/v1/labels/${encodeURIComponent(id)}`),
	importFoldersDryRun: () => post<FolderImportPlan>("/api/v1/labels/import-folders", { dryRun: true }),
	importFolders: () => post<FolderImportResult>("/api/v1/labels/import-folders", { dryRun: false, confirm: true }),

	// Mail index
	getIndexStatus: () => get<IndexStatusResponse>("/api/v1/index/status"),
	rebuildIndex: () => post<unknown>("/api/v1/index/rebuild"),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),
};

export default api;
