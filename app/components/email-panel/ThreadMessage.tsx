// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowSquareOutIcon,
	CaretDownIcon,
	CaretUpIcon,
	CodeIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	ProhibitIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import BlockSenderDialog from "~/components/BlockSenderDialog";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailIframe from "~/components/EmailIframe";
import EmailQuickActions from "~/components/EmailQuickActions";
import { detectUnsubscribe } from "~/lib/unsubscribe";
import {
	formatDetailDate,
	formatShortDate,
	rewriteInlineImages,
	stripHtml,
} from "~/lib/utils";
import api from "~/services/api";
import type { Email } from "~/types";

interface ThreadMessageProps {
	email: Email;
	mailboxId?: string;
	mailboxEmail?: string;
	isLast: boolean;
	isDraft?: boolean;
	isSending?: boolean;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onSendDraft?: () => void;
	onEditDraft?: () => void;
	onDeleteDraft?: () => void;
	onViewSource?: () => void;
	onPreviewImage?: (url: string, filename: string) => void;
}

function Avatar({ isDraft, isSelf, sender }: { isDraft?: boolean; isSelf: boolean; sender: string }) {
	return (
		<div
			className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
				isDraft
					? "bg-kumo-fill text-kumo-subtle"
					: isSelf
						? "bg-kumo-brand text-kumo-inverse"
						: "bg-kumo-fill text-kumo-default"
			}`}
		>
			{isDraft ? "D" : sender.charAt(0).toUpperCase()}
		</div>
	);
}

export default function ThreadMessage({
	email,
	mailboxId,
	mailboxEmail,
	isLast,
	isDraft,
	isSending,
	isExpanded,
	onToggleExpand,
	onSendDraft,
	onEditDraft,
	onDeleteDraft,
	onViewSource,
	onPreviewImage,
}: ThreadMessageProps) {
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const isSelf = email.sender === mailboxEmail;
	const unsub = useMemo(() => (!isSelf && !isDraft ? detectUnsubscribe(email) : null), [email, isSelf, isDraft]);
	const [isBlockOpen, setIsBlockOpen] = useState(false);

	const { data: blockedData } = useQuery({
		queryKey: ["blocked-senders", mailboxId],
		queryFn: () => (mailboxId ? api.getBlockedSenders(mailboxId) : null),
		enabled: !!mailboxId && !isSelf && !isDraft,
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
	const containerClassName = `${!isLast ? "border-b border-kumo-line" : ""} ${isDraft ? "border-l-2 border-l-kumo-warning bg-kumo-warning/[0.02]" : ""}`;
	const senderLabel = isDraft ? "Draft reply" : isSelf ? "You" : email.sender;

	if (!isExpanded) {
		return (
			<div className={containerClassName}>
				<button
					type="button"
					onClick={onToggleExpand}
					className="w-full flex items-center gap-3 px-4 py-3 hover:bg-kumo-tint rounded-lg text-left"
				>
					<Avatar isDraft={isDraft} isSelf={isSelf} sender={email.sender} />
					<div className="flex-1 min-w-0">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium text-kumo-default truncate">
								{senderLabel}
							</span>
							<span className="text-xs text-kumo-subtle shrink-0">
								{formatDetailDate(email.date)}
							</span>
						</div>
						<p className="text-xs text-kumo-subtle truncate">
							{stripHtml(email.body || "").slice(0, 80)}
						</p>
					</div>
					<CaretDownIcon size={14} className="text-kumo-subtle shrink-0" />
				</button>
			</div>
		);
	}

	return (
		<div className={`group/thread-msg ${containerClassName}`}>
			<div className="px-4 py-4 md:px-6">
				<div className="flex items-center justify-between gap-3 mb-3">
					<div className="flex items-center gap-2.5 min-w-0">
						<button
							type="button"
							onClick={onToggleExpand}
							className="shrink-0"
							aria-label="Collapse message"
						>
							<div className="cursor-pointer hover:ring-2 hover:ring-kumo-brand/30 transition-shadow rounded-full">
								<Avatar isDraft={isDraft} isSelf={isSelf} sender={email.sender} />
							</div>
						</button>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<span className="text-sm font-medium text-kumo-default truncate">
									{senderLabel}
								</span>
								{isDraft && <Badge variant="outline">Draft</Badge>}
							</div>
							<div className="text-xs text-kumo-subtle">To: {email.recipient}</div>
						</div>
					</div>
					<div className="flex items-center gap-1.5 shrink-0">
						{unsub && (
							<Tooltip content={unsub.url.startsWith("mailto:") ? "Send email to unsubscribe" : "Open unsubscribe page"} side="bottom" asChild>
								<Button
									variant="secondary"
									size="sm"
									icon={<ArrowSquareOutIcon size={12} />}
									onClick={handleUnsubscribe}
									className="!h-6 !px-2 text-xs"
								>
									Unsubscribe
								</Button>
							</Tooltip>
						)}
						{mailboxId && !isSelf && !isDraft && (
							isBlocked ? (
								<Tooltip
									content={isGlobalBlocked ? "Unblock this sender across all accounts" : `Unblock this sender for ${mailboxId}`}
									side="bottom"
									asChild
								>
									<Button
										variant="secondary"
										size="sm"
										icon={<ProhibitIcon size={12} className="text-kumo-warning" />}
										onClick={handleUnblock}
										className="!h-6 !px-2 text-xs"
									>
										{isGlobalBlocked ? "Unblock All" : "Unblock"}
									</Button>
								</Tooltip>
							) : (
								<Tooltip content={`Block ${email.sender}`} side="bottom" asChild>
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										icon={<ProhibitIcon size={14} className="text-kumo-danger" />}
										onClick={() => setIsBlockOpen(true)}
										aria-label="Block sender"
										className="!h-6 !w-6"
									/>
								</Tooltip>
							)
						)}
						<span className="text-xs text-kumo-subtle">
							{formatShortDate(email.date)}
						</span>
						{onViewSource && (
							<Tooltip content="View source" side="bottom" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<CodeIcon size={14} />}
									onClick={onViewSource}
									aria-label="View source"
									className="transition-opacity !h-6 !w-6"
								/>
							</Tooltip>
						)}
						<button
							type="button"
							onClick={onToggleExpand}
							className="ml-1"
							aria-label="Collapse message"
						>
							<CaretUpIcon
								size={14}
								className="text-kumo-subtle hover:text-kumo-default transition-colors"
							/>
						</button>
					</div>
				</div>
				<EmailQuickActions email={email} className="mb-3 md:ml-[42px]" />

				<div className="md:ml-[42px]">
					<EmailIframe
						body={rewriteInlineImages(
							email.body || "",
							mailboxId || "",
							email.id,
							email.attachments,
						)}
						autoSize
					/>
				</div>

				{isDraft && (onSendDraft || onEditDraft || onDeleteDraft) && (
					<div className="flex gap-2 mt-3 md:ml-[42px]">
						{onSendDraft && (
							<Button
								variant="primary"
								size="sm"
								icon={<PaperPlaneTiltIcon size={14} />}
								onClick={onSendDraft}
								loading={isSending}
								disabled={isSending}
							>
								{isSending ? "Sending..." : "Send"}
							</Button>
						)}
						{onEditDraft && (
							<Button
								variant="secondary"
								size="sm"
								icon={<PencilSimpleIcon size={14} />}
								onClick={onEditDraft}
								disabled={isSending}
							>
								Edit
							</Button>
						)}
						{onDeleteDraft && (
							<Button
								variant="ghost"
								size="sm"
								icon={<TrashIcon size={14} />}
								onClick={onDeleteDraft}
								disabled={isSending}
							>
								Discard
							</Button>
						)}
					</div>
				)}

				<EmailAttachmentList
					mailboxId={mailboxId}
					emailId={email.id}
					attachments={email.attachments}
					onPreviewImage={onPreviewImage}
					className="mt-3 md:ml-[42px]"
				/>
			</div>

			{mailboxId && !isSelf && !isDraft && (
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
