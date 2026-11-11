// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, ProhibitIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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
			const win = window.open(unsub.url, "_blank", "noopener,noreferrer");
			if (!win || win.closed || typeof win.closed === "undefined") {
				window.location.href = unsub.url;
			}
			toastManager.add({
				title: "Opening unsubscribe page...",
				description: "Redirecting to sender's unsubscribe link.",
			});
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
