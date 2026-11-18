// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Email, Mailbox } from "~/types";
import { queryKeys } from "./keys";

// ---------- Types ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

// ---------- Queries ----------

export function useEmails(
	mailboxId: string | undefined,
	params: Record<string, string>,
	options?: { enabled?: boolean; refetchInterval?: number },
) {
	const queryParams = params.folder
		? { ...params, threaded: "true" }
		: params;

	return useQuery<EmailListResponse>({
		queryKey: mailboxId
			? queryKeys.emails.list(mailboxId, queryParams)
			: ["emails", "_disabled"],
		queryFn: async () => {
			const data = await api.listEmails(mailboxId!, queryParams) as
				| EmailListResponse
				| Email[];
			if (data && typeof data === "object" && "emails" in data) {
				return {
					emails: (data as EmailListResponse).emails ?? [],
					totalCount: (data as EmailListResponse).totalCount ?? 0,
				};
			}
			const arr = Array.isArray(data) ? data : [];
			return { emails: arr, totalCount: arr.length };
		},
		enabled: !!mailboxId && (options?.enabled ?? true),
		refetchInterval: options?.refetchInterval,
	});
}

export function useAllEmails(
	params: Record<string, string>,
	options?: { enabled?: boolean; refetchInterval?: number },
) {
	return useQuery<EmailListResponse>({
		queryKey: queryKeys.emails.allList(params),
		queryFn: ({ signal }) => api.listAllEmails(params, { signal }) as Promise<EmailListResponse>,
		enabled: options?.enabled ?? true,
		refetchInterval: options?.refetchInterval,
	});
}

export function useEmail(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	return useQuery<Email>({
		queryKey: mailboxId && emailId
			? queryKeys.emails.detail(mailboxId, emailId)
			: ["emails", "_disabled_detail"],
		queryFn: () => api.getEmail(mailboxId!, emailId!) as Promise<Email>,
		enabled: !!mailboxId && !!emailId,
	});
}

export function useThreadReplies(
	mailboxId: string | undefined,
	threadId: string | undefined | null,
) {
	const qc = useQueryClient();

	return useQuery<Email[]>({
		queryKey: mailboxId && threadId
			? queryKeys.emails.thread(mailboxId, threadId)
			: ["emails", "_disabled_thread"],
		queryFn: async ({ signal }) => {
			// Single request returns all thread emails with full bodies +
			// attachments. Eliminates the previous N+1 pattern that fired
			// a separate getEmail call per thread message.
			const emails = await api.getThread(mailboxId!, threadId!, { signal }) as Email[];

			// Populate individual email detail caches so clicking a thread
			// message in the panel doesn't re-fetch.
			for (const email of emails) {
				qc.setQueryData(
					queryKeys.emails.detail(mailboxId!, email.id),
					email,
				);
			}

			return emails;
		},
		enabled: !!mailboxId && !!threadId,
	});
}

// ---------- Mutations ----------

/** Invalidate both the email list and folder counts after any email mutation. */
function useInvalidateEmailData() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({ queryKey: ["all-emails"] });
		qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		qc.invalidateQueries({
			queryKey: queryKeys.folders.list(mailboxId),
		});
	};
}

export function useSendEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			email,
		}: { mailboxId: string; email: unknown }) =>
			api.sendEmail(mailboxId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

const isMailboxListQuery = (mailboxId: string) => (query: { queryKey: readonly unknown[] }) =>
	query.queryKey[0] === "emails" &&
	query.queryKey[1] === mailboxId &&
	typeof query.queryKey[2] === "object" &&
	query.queryKey[2] !== null;

function patchEmailReadOrStar(email: Email, patch: Partial<Email>): Email {
	const next: Email = { ...email, ...patch };
	if (typeof patch.read === "boolean") {
		next.thread_unread_count = patch.read ? 0 : Math.max(1, email.thread_unread_count ?? 1);
	}
	return next;
}

export function useUpdateEmail() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			data,
		}: { mailboxId: string; id: string; data: unknown }) =>
			api.updateEmail(mailboxId, id, data),
		onMutate: async ({ mailboxId, id, data }) => {
			const patch = data as Partial<Email>;
			const predicate = isMailboxListQuery(mailboxId);

			// Cancel in-flight list queries so they don't overwrite our optimistic update
			await Promise.all([
				qc.cancelQueries({ queryKey: ["emails", mailboxId], predicate }),
				qc.cancelQueries({ queryKey: ["all-emails"] }),
			]);

			// Snapshot current mailbox + all-emails list caches for rollback
			const listQueries = qc.getQueriesData<{ emails: Email[]; totalCount: number }>({
				queryKey: ["emails", mailboxId],
				predicate,
			});
			const allListQueries = qc.getQueriesData<{ emails: Email[]; totalCount: number }>({
				queryKey: ["all-emails"],
			});

			let prevWasUnread: boolean | null = null;
			for (const [key, cached] of listQueries) {
				if (!cached?.emails) continue;
				qc.setQueryData(key, {
					...cached,
					emails: cached.emails.map((e) => {
						if (e.id !== id) return e;
						if (prevWasUnread === null) prevWasUnread = !e.read;
						return patchEmailReadOrStar(e, patch);
					}),
				});
			}

			for (const [key, cached] of allListQueries) {
				if (!cached?.emails) continue;
				qc.setQueryData(key, {
					...cached,
					emails: cached.emails.map((e) => {
						if (e.id !== id || (e.mailbox_id && e.mailbox_id !== mailboxId)) return e;
						if (prevWasUnread === null) prevWasUnread = !e.read;
						return patchEmailReadOrStar(e, patch);
					}),
				});
			}

			// Also patch the detail cache
			const detailKey = queryKeys.emails.detail(mailboxId, id);
			const prevDetail = qc.getQueryData<Email>(detailKey);
			if (prevDetail) {
				if (prevWasUnread === null) prevWasUnread = !prevDetail.read;
				qc.setQueryData(detailKey, { ...prevDetail, ...patch });
			}

			const prevMailboxes = qc.getQueryData<Mailbox[]>(queryKeys.mailboxes.all);
			if (typeof patch.read === "boolean" && prevMailboxes && prevWasUnread !== null && prevWasUnread !== !patch.read) {
				const delta = patch.read ? -1 : 1;
				qc.setQueryData<Mailbox[]>(
					queryKeys.mailboxes.all,
					prevMailboxes.map((mb) =>
						mb.id === mailboxId
							? { ...mb, unreadCount: Math.max(0, (mb.unreadCount ?? 0) + delta) }
							: mb,
					),
				);
			}

			return { listQueries, allListQueries, prevDetail, detailKey, prevMailboxes };
		},
		onError: (_err, _vars, context) => {
			if (context?.listQueries) {
				for (const [key, cached] of context.listQueries) {
					qc.setQueryData(key, cached);
				}
			}
			if (context?.allListQueries) {
				for (const [key, cached] of context.allListQueries) {
					qc.setQueryData(key, cached);
				}
			}
			if (context?.prevDetail) {
				qc.setQueryData(context.detailKey, context.prevDetail);
			}
			if (context?.prevMailboxes) {
				qc.setQueryData(queryKeys.mailboxes.all, context.prevMailboxes);
			}
		},
		onSettled: (_data, err, { mailboxId, data }) => {
			const patch = data as Partial<Email>;
			if (err) {
				qc.invalidateQueries({ queryKey: ["emails", mailboxId], predicate: isMailboxListQuery(mailboxId) });
				qc.invalidateQueries({ queryKey: ["all-emails"] });
				qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
			}
			if (typeof patch.read === "boolean") {
				qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
			}
		},
	});
}

export function useMarkThreadRead() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			threadId,
		}: { mailboxId: string; threadId: string }) =>
			api.markThreadRead(mailboxId, threadId),
		onMutate: async ({ mailboxId, threadId }) => {
			const predicate = isMailboxListQuery(mailboxId);
			await Promise.all([
				qc.cancelQueries({ queryKey: ["emails", mailboxId], predicate }),
				qc.cancelQueries({ queryKey: ["all-emails"] }),
			]);

			const listQueries = qc.getQueriesData<{ emails: Email[]; totalCount: number }>({
				queryKey: ["emails", mailboxId],
				predicate,
			});
			const allListQueries = qc.getQueriesData<{ emails: Email[]; totalCount: number }>({
				queryKey: ["all-emails"],
			});

			let unreadDelta = 0;
			const markMatch = (e: Email) => {
				if (e.thread_id !== threadId && e.id !== threadId) return e;
				if (!unreadDelta && (e.thread_unread_count ?? (e.read ? 0 : 1)) > 0) {
					unreadDelta = -(e.thread_unread_count ?? 1);
				}
				return { ...e, read: true, thread_unread_count: 0 };
			};

			for (const [key, cached] of listQueries) {
				if (!cached?.emails) continue;
				qc.setQueryData(key, { ...cached, emails: cached.emails.map(markMatch) });
			}
			for (const [key, cached] of allListQueries) {
				if (!cached?.emails) continue;
				qc.setQueryData(key, {
					...cached,
					emails: cached.emails.map((e) =>
						!e.mailbox_id || e.mailbox_id === mailboxId ? markMatch(e) : e,
					),
				});
			}

			const prevMailboxes = qc.getQueryData<Mailbox[]>(queryKeys.mailboxes.all);
			if (prevMailboxes && unreadDelta < 0) {
				qc.setQueryData<Mailbox[]>(
					queryKeys.mailboxes.all,
					prevMailboxes.map((mb) =>
						mb.id === mailboxId
							? { ...mb, unreadCount: Math.max(0, (mb.unreadCount ?? 0) + unreadDelta) }
							: mb,
					),
				);
			}

			return { listQueries, allListQueries, prevMailboxes };
		},
		onError: (_err, { mailboxId }, context) => {
			if (context?.listQueries) {
				for (const [key, cached] of context.listQueries) {
					qc.setQueryData(key, cached);
				}
			}
			if (context?.allListQueries) {
				for (const [key, cached] of context.allListQueries) {
					qc.setQueryData(key, cached);
				}
			}
			if (context?.prevMailboxes) {
				qc.setQueryData(queryKeys.mailboxes.all, context.prevMailboxes);
			}
			qc.invalidateQueries({ queryKey: ["emails", mailboxId], predicate: isMailboxListQuery(mailboxId) });
			qc.invalidateQueries({ queryKey: ["all-emails"] });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
		onSettled: (_data, _err, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		},
	});
}

export function useMarkAllRead() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, folder }: { mailboxId: string; folder?: string }) =>
			api.markAllRead(mailboxId, folder),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({ queryKey: ["all-emails"] });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
			qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		},
	});
}

export function useMarkAllEmailsRead() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ folder }: { folder?: string } = {}) =>
			api.markAllEmailsRead(folder),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["all-emails"] });
			qc.invalidateQueries({ queryKey: ["emails"] });
			qc.invalidateQueries({ queryKey: ["folders"] });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useDeleteEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
		}: { mailboxId: string; id: string }) =>
			api.deleteEmail(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useMoveEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			folderId,
		}: { mailboxId: string; id: string; folderId: string }) =>
			api.moveEmail(mailboxId, id, folderId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useBatchMoveEmails() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			ids,
			folderId,
		}: { mailboxId: string; ids: string[]; folderId: string }) =>
			api.batchMoveEmails(mailboxId, ids, folderId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useBatchDeleteEmails() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			ids,
		}: { mailboxId: string; ids: string[] }) =>
			api.batchDeleteEmails(mailboxId, ids),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useEmptyTrash() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({ mailboxId }: { mailboxId: string }) =>
			api.emptyTrash(mailboxId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useEmptyAllTrash() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.emptyAllTrash(),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["all-emails"] });
			qc.invalidateQueries({ queryKey: ["emails"] });
			qc.invalidateQueries({ queryKey: ["folders"] });
			qc.invalidateQueries({ queryKey: ["mailboxes"] });
		},
	});
}

export function useSaveDraft() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			draft,
		}: {
			mailboxId: string;
			draft: {
				to?: string;
				cc?: string;
				bcc?: string;
				subject?: string;
				body: string;
				in_reply_to?: string;
				thread_id?: string;
				draft_id?: string;
			};
		}) => api.saveDraft(mailboxId, draft),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useReplyToEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			email,
		}: { mailboxId: string; emailId: string; email: unknown }) =>
			api.replyToEmail(mailboxId, emailId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useForwardEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			email,
		}: { mailboxId: string; emailId: string; email: unknown }) =>
			api.forwardEmail(mailboxId, emailId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}
