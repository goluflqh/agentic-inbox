// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, Select, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, PlusIcon, ProhibitIcon, RobotIcon, TrashIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import api from "~/services/api";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	const { data: blockedData, refetch: refetchBlocked } = useQuery({
		queryKey: ["blocked-senders", mailboxId],
		queryFn: () => (mailboxId ? api.getBlockedSenders(mailboxId) : null),
		enabled: !!mailboxId,
	});

	const [manualBlockInput, setManualBlockInput] = useState("");
	const [manualBlockScope, setManualBlockScope] = useState<"mailbox" | "global">("mailbox");
	const [isAddingBlock, setIsAddingBlock] = useState(false);

	const handleAddBlock = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!mailboxId || !manualBlockInput.trim()) return;
		setIsAddingBlock(true);
		try {
			await api.blockSender(mailboxId, {
				sender: manualBlockInput.trim(),
				scope: manualBlockScope,
				moveToTrash: false,
			});
			toastManager.add({ title: `Added ${manualBlockInput.trim()} to blocklist` });
			setManualBlockInput("");
			refetchBlocked();
		} catch {
			toastManager.add({ title: "Failed to add to blocklist", variant: "error" });
		} finally {
			setIsAddingBlock(false);
		}
	};

	const handleUnblock = async (sender: string, scope: "mailbox" | "global") => {
		if (!mailboxId) return;
		try {
			await api.unblockSender(mailboxId, sender, scope);
			toastManager.add({ title: `Unblocked ${sender}` });
			refetchBlocked();
		} catch {
			toastManager.add({ title: "Failed to unblock sender", variant: "error" });
		}
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								AI Agent Prompt
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Customize how the AI agent behaves for this mailbox.
						Leave empty to use the built-in default prompt.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</div>

				{/* Blocked Senders Card */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5 space-y-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<ProhibitIcon size={18} className="text-kumo-danger" />
							<span className="text-sm font-medium text-kumo-default">
								Blocked Senders
							</span>
						</div>
					</div>
					<p className="text-xs text-kumo-subtle">
						Emails from these senders are automatically routed to Trash. All other emails arrive normally in your Inbox.
					</p>

					{/* Add block form */}
					<form onSubmit={handleAddBlock} className="flex flex-col sm:flex-row gap-2">
						<Input
							placeholder="e.g. spam@domain.com or @spamsite.com"
							value={manualBlockInput}
							onChange={(e) => setManualBlockInput(e.target.value)}
							className="flex-1"
							size="sm"
						/>
						<div className="w-36">
							<Select
								value={manualBlockScope}
								onValueChange={(val) => val && setManualBlockScope(val as "mailbox" | "global")}
								size="sm"
							>
								<Select.Option value="mailbox">This mailbox</Select.Option>
								<Select.Option value="global">All mailboxes</Select.Option>
							</Select>
						</div>
						<Button
							type="submit"
							variant="secondary"
							size="sm"
							icon={<PlusIcon size={14} />}
							loading={isAddingBlock}
							disabled={!manualBlockInput.trim()}
						>
							Block
						</Button>
					</form>

					{/* Blocked List */}
					<div className="space-y-2 pt-2">
						{(!blockedData || (blockedData.mailboxBlocked.length === 0 && blockedData.globalBlocked.length === 0)) ? (
							<div className="rounded-lg border border-dashed border-kumo-line bg-kumo-recessed p-4 text-center text-xs text-kumo-subtle">
								No senders are currently blocked. Your mailbox receives all emails normally.
							</div>
						) : (
							<div className="divide-y divide-kumo-line rounded-lg border border-kumo-line bg-kumo-recessed overflow-hidden">
								{blockedData.mailboxBlocked.map((sender) => (
									<div key={`mb-${sender}`} className="flex items-center justify-between px-3 py-2 text-xs">
										<div className="flex items-center gap-2 min-w-0">
											<span className="font-mono text-kumo-default truncate">{sender}</span>
											<Badge variant="secondary" className="text-[10px]">This mailbox</Badge>
										</div>
										<Button
											variant="ghost"
											size="xs"
											onClick={() => handleUnblock(sender, "mailbox")}
										>
											Unblock
										</Button>
									</div>
								))}
								{blockedData.globalBlocked.map((sender) => (
									<div key={`gb-${sender}`} className="flex items-center justify-between px-3 py-2 text-xs">
										<div className="flex items-center gap-2 min-w-0">
											<span className="font-mono text-kumo-default truncate">{sender}</span>
											<Badge variant="outline" className="text-[10px]">All mailboxes</Badge>
										</div>
										<Button
											variant="ghost"
											size="xs"
											onClick={() => handleUnblock(sender, "global")}
										>
											Unblock
										</Button>
									</div>
								))}
							</div>
						)}
					</div>
				</div>

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Save Changes
					</Button>
				</div>
			</div>
		</div>
	);
}
