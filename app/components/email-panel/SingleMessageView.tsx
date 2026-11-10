// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, ProhibitIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import BlockSenderDialog from "~/components/BlockSenderDialog";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailIframe from "~/components/EmailIframe";
import EmailQuickActions from "~/components/EmailQuickActions";
import { detectUnsubscribe } from "~/lib/unsubscribe";
import { formatDetailDate, rewriteInlineImages } from "~/lib/utils";
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
	const [isBlockOpen, setIsBlockOpen] = useState(false);
	const unsub = useMemo(() => detectUnsubscribe(email), [email]);

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
							<Tooltip content="Unsubscribe from this sender's mailing list" side="bottom" asChild>
								<Button
									variant="secondary"
									size="sm"
									icon={<ArrowSquareOutIcon size={14} />}
									onClick={() => {
										window.open(unsub.url, "_blank", "noopener,noreferrer");
									}}
								>
									Unsubscribe
								</Button>
							</Tooltip>
						)}
						{mailboxId && (
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
