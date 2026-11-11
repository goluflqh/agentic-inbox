// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, ProhibitIcon, TrashIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Folders } from "shared/folders";
import BlockSenderDialog from "~/components/BlockSenderDialog";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailIframe from "~/components/EmailIframe";
import EmailQuickActions from "~/components/EmailQuickActions";
import { detectUnsubscribe } from "~/lib/unsubscribe";
import { formatDetailDate, rewriteInlineImages } from "~/lib/utils";
import api from "~/services/api";
import type { Email } from "~/types";

interface SingleMessageViewProps {
	email: Email;
	mailboxId?: string;
	onPreviewImage: (url: string, filename: string) => void;
}

export default function SingleMessageView({
	email,
	mailboxId,
	onPreviewImage,
}: SingleMessageViewProps) {
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const [isBlockOpen, setIsBlockOpen] = useState(false);
	const unsub = useMemo(() => detectUnsubscribe(email), [email]);

	const { data: blockedData } = useQuery({
		queryKey: ["blocked-senders", mailboxId],
		queryFn: () => (mailboxId ? api.getBlockedSenders(mailboxId) : null),
		enabled: !!mailboxId,
		staleTime: 30_000,
	});

	const senderNormalized = (email.sender || "").toLowerCase().trim();
	const isGlobalBlocked = (blockedData?.globalBlocked || []).some((p) => {
		const norm = p.toLowerCase().trim();
		return norm.startsWith("@") ? senderNormalized.endsWith(norm) : senderNormalized === norm;
	});
	const isMailboxBlocked = (blockedData?.mailboxBlocked || []).some((p) => {
		const norm = p.toLowerCase().trim();
		return norm.startsWith("@") ? senderNormalized.endsWith(norm) : senderNormalized === norm;
	});
	const isBlocked = isGlobalBlocked || isMailboxBlocked;

	const handleUnblock = async () => {
		if (!mailboxId) return;
		const scope = isGlobalBlocked ? "global" : "mailbox";
		try {
			await api.unblockSender(mailboxId, senderNormalized, scope);
			queryClient.invalidateQueries({ queryKey: ["blocked-senders", mailboxId] });
			toastManager.add({
				title: scope === "global" ? `Unblocked ${senderNormalized} for all accounts` : `Unblocked ${senderNormalized}`,
				description: "This sender will now deliver to inbox normally.",
			});
		} catch {
			toastManager.add({ title: "Failed to unblock sender", variant: "error" });
		}
	};

	const handleUnsubscribe = () => {
		if (!unsub) return;
		if (unsub.url.startsWith("mailto:")) {
			window.location.href = unsub.url;
			toastManager.add({
				title: "Opening email client...",
				description: `Sending unsubscribe request to ${unsub.url.replace(/^mailto:/i, "")}`,
			});
		} else {
			const link = document.createElement("a");
			link.href = unsub.url;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			toastManager.add({
				title: "Opening unsubscribe page...",
				description: "Opened in a new tab.",
			});
		}
	};

	const [isCleaning, setIsCleaning] = useState(false);
	const handleCleanSenderToTrash = async () => {
		if (!mailboxId) return;
		setIsCleaning(true);
		try {
			const res = await api.blockSender(mailboxId, {
				sender: senderNormalized,
				scope: isGlobalBlocked ? "global" : "mailbox",
				moveToTrash: true,
			});
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({ queryKey: ["all-emails"] });
			queryClient.invalidateQueries({ queryKey: ["folders", mailboxId] });
			queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
			toastManager.add({
				title: "Moved emails to Trash",
				description: `Moved ${res.movedCount ?? 0} conversation(s) from ${senderNormalized} to Trash.`,
			});
		} catch (err: any) {
			toastManager.add({
				title: "Failed to move emails to Trash",
				description: err?.message || "An unexpected error occurred",
				variant: "error",
			});
		} finally {
			setIsCleaning(false);
		}
	};

	return (
		<div className="flex flex-col h-full">
			<div className="px-4 py-4 border-b border-kumo-line md:px-6">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-2.5 min-w-0">
						<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-xs font-bold text-kumo-default">
							{email.sender.charAt(0).toUpperCase()}
						</div>
						<div className="min-w-0">
							<div className="text-sm font-medium text-kumo-default truncate">
								{email.sender}
							</div>
							<div className="text-xs text-kumo-subtle">To: {email.recipient}</div>
						</div>
					</div>

					<div className="flex items-center gap-2 shrink-0">
						{unsub && (
							<Tooltip content={unsub.url.startsWith("mailto:") ? "Send email to unsubscribe" : "Open unsubscribe page"} side="bottom" asChild>
								<Button
									variant="secondary"
									size="sm"
									icon={<ArrowSquareOutIcon size={14} />}
									onClick={handleUnsubscribe}
								>
									Unsubscribe
								</Button>
							</Tooltip>
						)}
						{mailboxId && (
							isBlocked ? (
								<>
									<Tooltip
										content={isGlobalBlocked ? "Unblock this sender across all accounts" : `Unblock this sender for ${mailboxId}`}
										side="bottom"
										asChild
									>
										<Button
											variant="secondary"
											size="sm"
											icon={<ProhibitIcon size={14} className="text-kumo-warning" />}
											onClick={handleUnblock}
										>
											{isGlobalBlocked ? "Unblock All Accounts" : "Unblock"}
										</Button>
									</Tooltip>
									{email.folder_id !== Folders.TRASH && (
										<Tooltip content="Chuyển toàn bộ email cũ từ người gửi này vào Thùng rác" side="bottom" asChild>
											<Button
												variant="secondary-destructive"
												size="sm"
												icon={<TrashIcon size={14} />}
												onClick={handleCleanSenderToTrash}
												loading={isCleaning}
											>
												Dọn vào Trash
											</Button>
										</Tooltip>
									)}
								</>
							) : (
								<Tooltip content={`Block ${email.sender}`} side="bottom" asChild>
									<Button
										variant="ghost"
										size="sm"
										icon={<ProhibitIcon size={14} className="text-kumo-danger" />}
										onClick={() => setIsBlockOpen(true)}
									>
										Block
									</Button>
								</Tooltip>
							)
						)}
						<span className="text-xs text-kumo-subtle shrink-0">
							{formatDetailDate(email.date)}
						</span>
					</div>
				</div>
				<EmailQuickActions email={email} className="mt-3" />
			</div>

			{isBlocked && email.folder_id !== Folders.TRASH && (
				<div className="flex items-center justify-between px-4 py-2.5 bg-kumo-warning/10 border-b border-kumo-warning/30 text-xs">
					<div className="flex items-center gap-2 text-kumo-warning font-medium">
						<ProhibitIcon size={16} />
						<span>
							Người gửi này đã bị chặn{isGlobalBlocked ? " trên tất cả tài khoản" : ""}, nhưng thư cũ vẫn còn trong Inbox.
						</span>
					</div>
					<Button
						variant="destructive"
						size="xs"
						icon={<TrashIcon size={12} />}
						onClick={handleCleanSenderToTrash}
						loading={isCleaning}
					>
						Chuyển tất cả vào Thùng rác
					</Button>
				</div>
			)}

			<div className="flex-1 min-h-0">
				<EmailIframe
					body={rewriteInlineImages(
						email.body || "",
						mailboxId || "",
						email.id,
						email.attachments,
					)}
				/>
			</div>

			<EmailAttachmentList
				mailboxId={mailboxId}
				emailId={email.id}
				attachments={email.attachments}
				onPreviewImage={onPreviewImage}
				className="px-4 py-3 border-t border-kumo-line shrink-0 md:px-6"
				showHeading
			/>

			{mailboxId && (
				<BlockSenderDialog
					open={isBlockOpen}
					onOpenChange={setIsBlockOpen}
					sender={email.sender}
					mailboxId={mailboxId}
				/>
			)}
		</div>
	);
}
