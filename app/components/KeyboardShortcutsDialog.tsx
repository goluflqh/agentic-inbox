// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Dialog } from "@cloudflare/kumo";
import { CommandIcon, XIcon } from "@phosphor-icons/react";

interface KeyboardShortcutsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const SHORTCUT_GROUPS = [
	{
		title: "Navigation",
		shortcuts: [
			{ keys: ["j", "↓"], description: "Next email in list" },
			{ keys: ["k", "↑"], description: "Previous email in list" },
			{ keys: ["Enter", "o"], description: "Open selected email" },
			{ keys: ["Esc"], description: "Close reading panel / Clear selection" },
		],
	},
	{
		title: "Email Actions",
		shortcuts: [
			{ keys: ["x"], description: "Select / Deselect email checkbox" },
			{ keys: ["e"], description: "Archive conversation" },
			{ keys: ["#", "Del"], description: "Move to Trash (or permanently delete if in Trash)" },
			{ keys: ["s"], description: "Toggle Star" },
			{ keys: ["u"], description: "Toggle Read / Unread" },
		],
	},
	{
		title: "Compose & Reply",
		shortcuts: [
			{ keys: ["c"], description: "Compose new email" },
			{ keys: ["r"], description: "Reply to sender (when viewing email)" },
			{ keys: ["a"], description: "Reply all (when viewing email)" },
			{ keys: ["f"], description: "Forward email" },
		],
	},
	{
		title: "Help",
		shortcuts: [
			{ keys: ["?"], description: "Show / hide keyboard shortcuts guide" },
		],
	},
];

export default function KeyboardShortcutsDialog({
	open,
	onOpenChange,
}: KeyboardShortcutsDialogProps) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog size="base" className="p-6 max-w-xl">
				<div className="flex items-center justify-between pb-3 border-b border-kumo-line mb-4">
					<div className="flex items-center gap-2">
						<CommandIcon size={20} className="text-kumo-default" />
						<Dialog.Title className="text-base font-semibold text-kumo-default">
							Keyboard Shortcuts
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

				<div className="grid grid-cols-1 sm:grid-cols-2 gap-5 max-h-[65vh] overflow-y-auto pr-1">
					{SHORTCUT_GROUPS.map((group) => (
						<div key={group.title} className="space-y-2">
							<h3 className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
								{group.title}
							</h3>
							<div className="space-y-1.5">
								{group.shortcuts.map((sc, i) => (
									<div
										key={i}
										className="flex items-center justify-between py-1 text-sm text-kumo-strong"
									>
										<span>{sc.description}</span>
										<div className="flex items-center gap-1 shrink-0 ml-2">
											{sc.keys.map((k) => (
												<kbd
													key={k}
													className="px-2 py-0.5 text-xs font-mono font-medium rounded border border-kumo-line bg-kumo-recessed text-kumo-default shadow-xs"
												>
													{k}
												</kbd>
											))}
										</div>
									</div>
								))}
							</div>
						</div>
					))}
				</div>

				<div className="mt-5 pt-3 border-t border-kumo-line flex justify-end">
					<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
						Got it
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
