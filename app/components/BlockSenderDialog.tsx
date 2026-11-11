// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Dialog, useKumoToastManager } from "@cloudflare/kumo";
import { ProhibitIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

interface BlockSenderDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sender: string;
	mailboxId: string;
	emailId?: string;
	onSuccess?: (movedCount: number) => void;
}

export default function BlockSenderDialog({
	open,
	onOpenChange,
	sender,
	mailboxId,
	emailId,
	onSuccess,
}: BlockSenderDialogProps) {
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const [scope, setScope] = useState<"mailbox" | "global">("mailbox");
	const [moveToTrash, setMoveToTrash] = useState(true);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleBlock = async () => {
		if (!sender || !mailboxId) return;
		setIsSubmitting(true);
		try {
			const res = await api.blockSender(mailboxId, {
				sender,
				scope,
				moveToTrash,
				emailId,
			});

			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({ queryKey: ["all-emails"] });
			queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			queryClient.invalidateQueries({ queryKey: ["blocked-senders", mailboxId] });
			if (emailId) queryClient.invalidateQueries({ queryKey: ["email", mailboxId, emailId] });

			const movedCount = res.movedCount || 0;
			const affectedMailboxCount = Object.keys(res.mailboxCounts || {}).length;
			let movedMsg = "";
			if (movedCount > 0) {
				if (scope === "global" && affectedMailboxCount > 1) {
					movedMsg = ` and moved ${movedCount} conversation(s) across ${affectedMailboxCount} accounts to Trash`;
				} else {
					movedMsg = ` and moved ${movedCount} conversation(s) to Trash`;
				}
			}

			toastManager.add({
				title: scope === "global" ? `Blocked ${sender} globally` : `Blocked ${sender}`,
				description: `Future emails from this sender will be routed directly to Trash${movedMsg}.`,
			});

			onOpenChange(false);
			onSuccess?.(res.movedCount);
		} catch (err) {
			toastManager.add({
				title: "Failed to block sender",
				description: err instanceof Error ? err.message : "An unexpected error occurred.",
				variant: "error",
			});
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog size="base" className="p-6 max-w-lg">
				<div className="flex items-center justify-between pb-3 border-b border-kumo-line mb-4">
					<div className="flex items-center gap-2">
						<ProhibitIcon size={20} className="text-kumo-danger" />
						<Dialog.Title className="text-base font-semibold text-kumo-default">
							Block Sender
						</Dialog.Title>
					</div>
					<Dialog.Close
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								size="sm"
								icon={<XIcon size={16} />}
								aria-label="Close"
							/>
						)}
					/>
				</div>

				<div className="space-y-4">
					<p className="text-sm text-kumo-strong">
						Are you sure you want to block <strong className="font-mono text-kumo-default">{sender}</strong>?
					</p>

					<div className="space-y-2">
						<label className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle block">
							Select Block Scope
						</label>

						<div className="space-y-2">
							<label className="flex items-start gap-3 p-3 rounded-lg border border-kumo-line bg-kumo-base hover:bg-kumo-tint transition-colors cursor-pointer">
								<input
									type="radio"
									name="block-scope"
									value="mailbox"
									checked={scope === "mailbox"}
									onChange={() => setScope("mailbox")}
									className="mt-0.5"
								/>
								<div className="text-xs">
									<div className="font-semibold text-kumo-default">
										This mailbox only ({mailboxId}) <span className="text-kumo-subtle font-normal">(Recommended)</span>
									</div>
									<div className="text-kumo-subtle mt-0.5">
										Only this account will reject emails from {sender}. Other accounts are completely unaffected.
									</div>
								</div>
							</label>

							<label className="flex items-start gap-3 p-3 rounded-lg border border-kumo-line bg-kumo-base hover:bg-kumo-tint transition-colors cursor-pointer">
								<input
									type="radio"
									name="block-scope"
									value="global"
									checked={scope === "global"}
									onChange={() => setScope("global")}
									className="mt-0.5"
								/>
								<div className="text-xs">
									<div className="font-semibold text-kumo-default">
										All mailboxes (Global block)
									</div>
									<div className="text-kumo-subtle mt-0.5">
										Block this sender across all domains and accounts in this inbox system.
									</div>
								</div>
							</label>
						</div>
					</div>

					<div className="pt-2">
						<label className="flex items-center gap-2.5 text-xs text-kumo-strong cursor-pointer">
							<input
								type="checkbox"
								checked={moveToTrash}
								onChange={(e) => setMoveToTrash(e.target.checked)}
							/>
							<span>
								Move all existing emails from this sender to <strong>Trash</strong>
								{scope === "global" ? " across all accounts" : " in this mailbox"}
							</span>
						</label>
					</div>

					<div className="flex justify-end gap-2 pt-4 border-t border-kumo-line">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" disabled={isSubmitting}>
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="primary"
							onClick={handleBlock}
							loading={isSubmitting}
						>
							Confirm Block
						</Button>
					</div>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
