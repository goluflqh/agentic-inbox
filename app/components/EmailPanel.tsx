// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { Folders } from "shared/folders";
import EmailPanelDialogs from "~/components/email-panel/EmailPanelDialogs";
import EmailPanelHeader from "~/components/email-panel/EmailPanelHeader";
import EmailPanelToolbar from "~/components/email-panel/EmailPanelToolbar";
import SingleMessageView from "~/components/email-panel/SingleMessageView";
import ThreadMessage from "~/components/email-panel/ThreadMessage";
import { splitEmailList, toEmailListValue } from "~/lib/utils";
import api from "~/services/api";
import { useDeleteEmail, useEmail, useMoveEmail, useReplyToEmail, useSendEmail, useThreadReplies, useUpdateEmail } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email, Folder, Mailbox } from "~/types";

function EmailPanelSkeleton() {
	return (
		<div className="animate-pulse p-5 space-y-4">
			<div className="h-5 w-2/3 rounded bg-kumo-fill" />
			<div className="flex items-center gap-3"><div className="w-10 h-10 rounded-full bg-kumo-fill" /><div className="space-y-2 flex-1"><div className="h-3 w-40 rounded bg-kumo-fill" /><div className="h-2.5 w-24 rounded bg-kumo-fill" /></div></div>
			<div className="space-y-2 pt-4"><div className="h-2.5 w-full rounded bg-kumo-fill" /><div className="h-2.5 w-5/6 rounded bg-kumo-fill" /><div className="h-2.5 w-4/6 rounded bg-kumo-fill" /><div className="h-2.5 w-3/4 rounded bg-kumo-fill" /></div>
		</div>
	);
}

export default function EmailPanel({
	emailId,
	mailboxIdOverride,
	folderOverride,
}: {
	emailId: string;
	mailboxIdOverride?: string;
	folderOverride?: string;
}) {
	const { mailboxId: routeMailboxId, folder: routeFolder } = useParams<{ mailboxId: string; folder: string }>();
	const mailboxId = mailboxIdOverride || routeMailboxId;
	const folder = folderOverride || routeFolder;
	const { data: email } = useEmail(mailboxId, emailId) as { data?: Email };
	const { data: threadRepliesRaw } = useThreadReplies(mailboxId, email?.thread_id) as {
		data?: Email[];
	};
	const updateEmail = useUpdateEmail();
	const deleteEmailMut = useDeleteEmail();
	const moveEmailMut = useMoveEmail();
	const sendEmailMut = useSendEmail();
	const replyMut = useReplyToEmail();
	const { data: folders = [] } = useFolders(mailboxId) as { data?: Folder[] };
	const { data: currentMailbox } = useMailbox(mailboxId) as {
		data?: Mailbox;
	};
	const { closePanel, startCompose } = useUIStore();
	const toastManager = useKumoToastManager();
	const [isSending, setIsSending] = useState(false);
	const [acceptedDraftIds, setAcceptedDraftIds] = useState<Set<string>>(new Set());
	const [sourceViewEmail, setSourceViewEmail] = useState<Email | null>(null);
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
	const [showDrafts, setShowDrafts] = useState(false);
	const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
	const isDraftFolder = folder === Folders.DRAFT;
	const isTrashFolder = (folder || email?.folder_id) === Folders.TRASH;

	const threadReplies = useMemo(() => {
		if (!threadRepliesRaw || !email) return [];
		return threadRepliesRaw.filter((e) => e.id !== email.id);
	}, [threadRepliesRaw, email]);

	const allMessages = useMemo(() => {
		if (!email) return [];
		return [email, ...threadReplies].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	}, [email, threadReplies]);

	// Reset expanded state only when the selected email changes, not on every refetch.
	// Using allMessages as a dependency would reset user expand/collapse state on background refetches.
	const currentEmailId = email?.id;
	useEffect(() => {
		setShowDrafts(false);
		const firstVisible = isDraftFolder ? allMessages[0] : allMessages.find((msg) => msg.folder_id !== Folders.DRAFT);
		if (firstVisible) setExpandedMessages(new Set([firstVisible.id]));
	}, [currentEmailId]); // eslint-disable-line react-hooks/exhaustive-deps

	const toggleExpand = (msgId: string) => { setExpandedMessages((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; }); };

	const draftMessageIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of allMessages) { if (msg.folder_id === Folders.DRAFT) ids.add(msg.id); else if (isDraftFolder && msg.id === emailId) ids.add(msg.id); }
		return ids;
	}, [allMessages, isDraftFolder, emailId]);

	const lastReceivedMessage = useMemo(() => {
		const ce = currentMailbox?.email;
		const received = allMessages.filter((msg) => !draftMessageIds.has(msg.id) && msg.sender !== ce);
		if (received.length > 0) return received[0];
		const nonDrafts = allMessages.filter((msg) => !draftMessageIds.has(msg.id));
		return nonDrafts.length > 0 ? nonDrafts[0] : email;
	}, [allMessages, draftMessageIds, currentMailbox?.email, email]);

	const moveToFolders = useMemo(() => { const cur = folder || email?.folder_id; return folders.filter((f) => f.id !== cur); }, [folders, folder, email?.folder_id]);

	if (!email) return <EmailPanelSkeleton />;

	const toggleStar = () => { if (mailboxId) updateEmail.mutate({ mailboxId, id: email.id, data: { starred: !email.starred } }); };
	const handleMove = (folderId: string) => { if (mailboxId) { moveEmailMut.mutate({ mailboxId, id: email.id, folderId }); closePanel(); } };
	const handleRestore = () => {
		if (mailboxId) {
			moveEmailMut.mutate({ mailboxId, id: email.id, folderId: Folders.INBOX });
			toastManager.add({ title: "Email restored to Inbox" });
			closePanel();
		}
	};
	const handleDelete = () => {
		if (!mailboxId) return;
		if (isTrashFolder) {
			if (!window.confirm("Are you sure you want to permanently delete this email? This action cannot be undone.")) return;
			deleteEmailMut.mutate({ mailboxId, id: email.id });
			toastManager.add({ title: "Email permanently deleted" });
			closePanel();
		} else {
			moveEmailMut.mutate({ mailboxId, id: email.id, folderId: Folders.TRASH });
			toastManager.add({ title: "Moved to Trash" });
			closePanel();
		}
	};

	const handleEditDraft = (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (target.in_reply_to) { startCompose({ mode: "reply", originalEmail: allMessages.find((msg) => msg.id === target.in_reply_to), draftEmail: target }); }
		else { startCompose({ mode: "new", originalEmail: undefined, draftEmail: target }); }
	};

	const handleDeleteDraft = async (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (!mailboxId) return;
		if (!window.confirm("Discard this draft?")) return;
		deleteEmailMut.mutate({ mailboxId, id: target.id });
		toastManager.add({ title: "Draft discarded" });
		if (target.id === emailId) closePanel();
	};

	const handleSendDraft = async (draftMsg?: Email) => {
		let target = draftMsg || email;
		if (!mailboxId || !currentMailbox || acceptedDraftIds.has(target.id)) return;
		setIsSending(true);
		try {
			if (!target.recipient || !target.subject) { try { const fresh = await api.getEmail(mailboxId, target.id) as Email; if (fresh) target = fresh; } catch {} }
			if (!target.recipient) { toastManager.add({ title: "Cannot send: no recipient set on this draft.", variant: "error" }); return; }
			const toRecipients = splitEmailList(target.recipient);
			if (toRecipients.length === 0) { toastManager.add({ title: "Cannot send: no valid recipient set on this draft.", variant: "error" }); return; }
			const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
			const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
			const originalEmail = target.in_reply_to ? allMessages.find((msg) => msg.id === target.in_reply_to) : undefined;
			const emailData = {
				to: toEmailListValue(toRecipients),
				cc: toEmailListValue(splitEmailList(target.cc)),
				bcc: toEmailListValue(splitEmailList(target.bcc)),
				from,
				subject: target.subject || "(no subject)",
				html: target.body || "",
				text: target.body ? target.body.replace(/<[^>]*>/g, "").trim() : "",
			};
			const result = originalEmail ? await replyMut.mutateAsync({ mailboxId, emailId: originalEmail.id, email: emailData }) : await sendEmailMut.mutateAsync({ mailboxId, email: emailData });
			if (result.status === "sent_save_failed") {
				setAcceptedDraftIds((ids) => new Set([...ids, target.id]));
				toastManager.add({ title: "Provider accepted the email, but the Sent copy failed. Do not resend; check the provider or recipient.", variant: "error" });
				return;
			}
			setAcceptedDraftIds((ids) => new Set([...ids, target.id]));
			try {
				await deleteEmailMut.mutateAsync({ mailboxId, id: target.id });
			} catch {
				toastManager.add({ title: "Email was sent, but its draft could not be removed. Do not resend it.", variant: "error" });
				return;
			}
			toastManager.add({ title: "Email sent!" });
			if (isDraftFolder) closePanel();
		} catch (err) {
			const message = (err instanceof Error ? err.message : null) || "Failed to send email.";
			toastManager.add({ title: message, variant: "error" });
		} finally { setIsSending(false); }
	};

	const hiddenDraftCount = isDraftFolder ? 0 : allMessages.filter((msg) => draftMessageIds.has(msg.id)).length;
	const visibleMessages = !isDraftFolder && !showDrafts ? allMessages.filter((msg) => !draftMessageIds.has(msg.id)) : allMessages;
	const hasThread = allMessages.length > 1;

	return (
		<div className="flex flex-col h-full">
			<EmailPanelToolbar
				email={email}
				mailboxId={mailboxId}
				isDraftFolder={isDraftFolder}
				isTrashFolder={isTrashFolder}
				isSending={isSending}
				moveToFolders={moveToFolders}
				onBack={closePanel}
				onSendDraft={() => handleSendDraft()}
				onEditDraft={() => handleEditDraft()}
				onReply={() =>
					startCompose({ mode: "reply", originalEmail: lastReceivedMessage })
				}
				onReplyAll={() =>
					startCompose({
						mode: "reply-all",
						originalEmail: lastReceivedMessage,
					})
				}
				onForward={() => startCompose({ mode: "forward", originalEmail: email })}
				onToggleStar={toggleStar}
				onToggleRead={() => {
					if (mailboxId) {
						updateEmail.mutate({
							mailboxId,
							id: email.id,
							data: { read: !email.read },
						});
					}
				}}
				onMove={handleMove}
				onViewSource={() => setSourceViewEmail(email)}
				onDelete={handleDelete}
				onRestore={handleRestore}
			/>

			<EmailPanelHeader
				subject={email.subject}
				messageCount={allMessages.length}
				showThreadCount={hasThread}
			/>

			<div className="flex-1 overflow-y-auto">
				{hiddenDraftCount > 0 && <div className="px-4 py-2 border-b border-kumo-line text-sm text-kumo-subtle">
					{hiddenDraftCount} draft{hiddenDraftCount === 1 ? "" : "s"} {showDrafts ? "shown" : "hidden"}. <button type="button" className="text-kumo-link underline" onClick={() => setShowDrafts(!showDrafts)}>{showDrafts ? "Hide drafts" : "Show drafts"}</button>
				</div>}
				{hasThread ? (
					visibleMessages.map((msg, idx) => {
						const isDraft = draftMessageIds.has(msg.id);
						return (
							<ThreadMessage
								key={msg.id}
								email={msg}
								mailboxId={mailboxId}
								mailboxEmail={currentMailbox?.email}
								isLast={idx === visibleMessages.length - 1}
								isDraft={isDraft}
								isSending={isDraft ? isSending : false}
								isExpanded={expandedMessages.has(msg.id)}
								onToggleExpand={() => toggleExpand(msg.id)}
								onSendDraft={isDraft ? () => handleSendDraft(msg) : undefined}
								onEditDraft={isDraft ? () => handleEditDraft(msg) : undefined}
								onDeleteDraft={isDraft ? () => handleDeleteDraft(msg) : undefined}
								onViewSource={() => setSourceViewEmail(msg)}
								onPreviewImage={(url, filename) =>
									setPreviewImage({ url, filename })
								}
							/>
						);
					})
				) : (
					<SingleMessageView
						email={email}
						mailboxId={mailboxId}
						onPreviewImage={(url, filename) =>
							setPreviewImage({ url, filename })
						}
					/>
				)}
			</div>

			<EmailPanelDialogs
				sourceViewEmail={sourceViewEmail}
				previewImage={previewImage}
				onCloseSource={() => setSourceViewEmail(null)}
				onClosePreview={() => setPreviewImage(null)}
			/>
		</div>
	);
}
