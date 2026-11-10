// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect } from "react";

interface KeyboardShortcutsOptions {
	onNext?: () => void;
	onPrevious?: () => void;
	onOpen?: () => void;
	onClose?: () => void;
	onToggleSelect?: () => void;
	onArchive?: () => void;
	onDelete?: () => void;
	onToggleStar?: () => void;
	onToggleRead?: () => void;
	onCompose?: () => void;
	onReply?: () => void;
	onReplyAll?: () => void;
	onForward?: () => void;
	onToggleHelp?: () => void;
	enabled?: boolean;
}

export function useKeyboardShortcuts({
	onNext,
	onPrevious,
	onOpen,
	onClose,
	onToggleSelect,
	onArchive,
	onDelete,
	onToggleStar,
	onToggleRead,
	onCompose,
	onReply,
	onReplyAll,
	onForward,
	onToggleHelp,
	enabled = true,
}: KeyboardShortcutsOptions) {
	useEffect(() => {
		if (!enabled) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			// Don't trigger if user is typing in an input, textarea, or contentEditable element
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT" ||
					target.isContentEditable ||
					target.closest("[contenteditable='true']"))
			) {
				return;
			}

			// Modifiers check: avoid conflicting with browser shortcuts like Ctrl+C, Ctrl+R
			if (e.ctrlKey || e.metaKey || e.altKey) return;

			switch (e.key) {
				case "j":
				case "ArrowDown":
					e.preventDefault();
					onNext?.();
					break;
				case "k":
				case "ArrowUp":
					e.preventDefault();
					onPrevious?.();
					break;
				case "Enter":
				case "o":
					e.preventDefault();
					onOpen?.();
					break;
				case "Escape":
					e.preventDefault();
					onClose?.();
					break;
				case "x":
					e.preventDefault();
					onToggleSelect?.();
					break;
				case "e":
					e.preventDefault();
					onArchive?.();
					break;
				case "Delete":
				case "#":
					e.preventDefault();
					onDelete?.();
					break;
				case "s":
					e.preventDefault();
					onToggleStar?.();
					break;
				case "u":
					e.preventDefault();
					onToggleRead?.();
					break;
				case "c":
					e.preventDefault();
					onCompose?.();
					break;
				case "r":
					e.preventDefault();
					onReply?.();
					break;
				case "a":
					e.preventDefault();
					onReplyAll?.();
					break;
				case "f":
					e.preventDefault();
					onForward?.();
					break;
				case "?":
					e.preventDefault();
					onToggleHelp?.();
					break;
				default:
					break;
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		enabled,
		onNext,
		onPrevious,
		onOpen,
		onClose,
		onToggleSelect,
		onArchive,
		onDelete,
		onToggleStar,
		onToggleRead,
		onCompose,
		onReply,
		onReplyAll,
		onForward,
		onToggleHelp,
	]);
}
