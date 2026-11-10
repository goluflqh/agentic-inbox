// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Pagination, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowCounterClockwiseIcon,
	ArrowsClockwiseIcon,
	CommandIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	FolderSimpleIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Folders } from "shared/folders";
import { formatListDate } from "shared/dates";
import EmailQuickActions from "~/components/EmailQuickActions";
import { highlightSearch, SearchMatchLabel } from "~/components/SearchMatch";
import MailboxSplitView from "~/components/MailboxSplitView";
import KeyboardShortcutsDialog from "~/components/KeyboardShortcutsDialog";
import { useKeyboardShortcuts } from "~/hooks/useKeyboardShortcuts";
import { getSnippetText } from "~/lib/utils";
import {
	useBatchDeleteEmails,
	useBatchMoveEmails,
	useDeleteEmail,
	useEmails,
	useEmptyTrash,
	useMarkThreadRead,
	useMoveEmail,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";

const PAGE_SIZE = 25;

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		title: string;
		description: string;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Your inbox is empty",
		description:
			"New emails will appear here when they arrive. Send an email to get the conversation started.",
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<PaperPlaneTiltIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: "No sent emails",
		description: "Emails you send will show up here.",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <FileIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "No drafts",
		description: "Emails you're still working on will be saved here.",
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <ArchiveIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Archive is empty",
		description:
			"Move emails here to keep your inbox clean without deleting them.",
	},
	[Folders.TRASH]: {
		icon: <TrashIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Trash is empty",
		description:
			"Deleted emails will appear here. You can restore them or permanently delete them.",
	},
};

function EmailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 w-4 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-12 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
}: {
	folder?: string;
	onCompose: () => void;
}) {
	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: "No emails",
		description: "This folder is empty.",
	};

	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{config.icon}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				{config.title}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">
				{config.description}
			</p>
			{"showCompose" in config && config.showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<PencilSimpleIcon size={16} />}
					onClick={onCompose}
				>
					Compose
				</Button>
			)}
		</div>
	);
}

export default function EmailListRoute() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const [searchParams, setSearchParams] = useSearchParams();
	const pageValue = Number(searchParams.get("page"));
	const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;
	const setPage = (nextPage: number) => {
		const params = new URLSearchParams(searchParams);
		if (nextPage <= 1) params.delete("page");
		else params.set("page", String(nextPage));
		setSearchParams(params);
	};

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const deleteEmail = useDeleteEmail();
	const statusParam = searchParams.get("status");
	const status = statusParam === "unread" || statusParam === "starred" ? statusParam : "all";
	const q = searchParams.get("q") || "";
	const [searchInput, setSearchInput] = useState(q);

	useEffect(() => {
		setSearchInput(q);
	}, [q]);

	const setFilter = (next: { status?: "all" | "unread" | "starred"; q?: string }) => {
		const params = new URLSearchParams(searchParams);
		const nextStatus = next.status ?? status;
		const nextQ = next.q ?? q;
		params.delete("page");
		if (nextStatus === "all") params.delete("status");
		else params.set("status", nextStatus);
		if (nextQ.trim()) params.set("q", nextQ.trim());
		else params.delete("q");
		setSearchParams(params);
	};

	const handleSearchSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		setFilter({ q: searchInput });
	};

	const params = useMemo(
		() => ({
			folder: folder || "",
			page: String(page),
			limit: String(PAGE_SIZE),
			...(status !== "all" ? { status } : {}),
			...(q ? { q } : {}),
		}),
		[folder, page, q, status],
	);

	const {
		data: emailData,
		isFetching: isRefreshing,
	} = useEmails(mailboxId, params, { refetchInterval: 30_000 });

	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

	const { data: folders = [] } = useFolders(mailboxId);

	const folderName = useMemo(() => {
		const found = folders.find((f) => f.id === folder);
		if (found) return found.name;
		return folder ? folder.charAt(0).toUpperCase() + folder.slice(1) : "Inbox";
	}, [folders, folder]);

	const isPanelOpen = selectedEmailId !== null || isComposing;

	// Track folder identity to detect folder changes vs page changes
	const prevFolderRef = useRef(`${mailboxId}/${folder}/${status}/${q}`);

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${mailboxId}/${folder}/${status}/${q}`;
		prevFolderRef.current = `${mailboxId}/${folder}/${status}/${q}`;

		if (folderChanged) {
			closePanel();
			setSelectedIds(new Set());
		}
	}, [mailboxId, folder, q, status, closePanel]);

	useEffect(() => {
		const visibleIds = new Set(emails.map((email) => email.id));
		setSelectedIds((current) => {
			const next = new Set([...current].filter((id) => visibleIds.has(id)));
			return next.size === current.size ? current : next;
		});
	}, [emails]);

	const moveEmailMut = useMoveEmail();
	const batchMoveMut = useBatchMoveEmails();
	const batchDeleteMut = useBatchDeleteEmails();
	const emptyTrashMut = useEmptyTrash();

	const isTrashFolder = folder === Folders.TRASH;

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId)
			updateEmail.mutate({
				mailboxId,
				id: email.id,
				data: { starred: !email.starred },
			});
	};

	const handleRowDelete = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		if (!mailboxId) return;
		if (isTrashFolder) {
			const confirmed = window.confirm("Are you sure you want to permanently delete this email? This action cannot be undone.");
			if (!confirmed) return;
			deleteEmail.mutate({ mailboxId, id: emailId });
			if (selectedEmailId === emailId) closePanel();
		} else {
			moveEmailMut.mutate({ mailboxId, id: emailId, folderId: Folders.TRASH });
			if (selectedEmailId === emailId) closePanel();
		}
	};

	const handleRowRestore = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		if (!mailboxId) return;
		moveEmailMut.mutate({ mailboxId, id: emailId, folderId: Folders.INBOX });
		if (selectedEmailId === emailId) closePanel();
	};

	const handleEmptyTrash = () => {
		if (!mailboxId) return;
		if (!window.confirm("Are you sure you want to permanently delete all emails in Trash? This action cannot be undone.")) return;
		emptyTrashMut.mutate({ mailboxId });
		closePanel();
		setSelectedIds(new Set());
	};

	const handleBatchDelete = () => {
		if (!mailboxId || selectedIds.size === 0) return;
		const ids = Array.from(selectedIds);
		if (isTrashFolder) {
			if (!window.confirm(`Permanently delete ${ids.length} selected email(s)? This action cannot be undone.`)) return;
			batchDeleteMut.mutate({ mailboxId, ids });
		} else {
			batchMoveMut.mutate({ mailboxId, ids, folderId: Folders.TRASH });
		}
		setSelectedIds(new Set());
	};

	const handleBatchRestore = () => {
		if (!mailboxId || selectedIds.size === 0) return;
		const ids = Array.from(selectedIds);
		batchMoveMut.mutate({ mailboxId, ids, folderId: Folders.INBOX });
		setSelectedIds(new Set());
	};

	const handleBatchMove = (targetFolderId: string) => {
		if (!mailboxId || selectedIds.size === 0) return;
		const ids = Array.from(selectedIds);
		batchMoveMut.mutate({ mailboxId, ids, folderId: targetFolderId });
		setSelectedIds(new Set());
	};

	const handleBatchStar = (starred: boolean) => {
		if (!mailboxId || selectedIds.size === 0) return;
		const targets = emails.filter((em) => selectedIds.has(em.id));
		Promise.all(targets.map((em) => updateEmail.mutateAsync({ mailboxId, id: em.id, data: { starred } })));
		setSelectedIds(new Set());
	};

	const handleRefresh = () => {
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	const allVisibleSelected = emails.length > 0 && emails.every((email) => selectedIds.has(email.id));
	const selectedCount = selectedIds.size;

	const toggleSelected = (emailId: string) => {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(emailId)) next.delete(emailId);
			else next.add(emailId);
			return next;
		});
	};

	const toggleAllVisible = () => {
		setSelectedIds((current) => {
			if (allVisibleSelected) return new Set();
			const next = new Set(current);
			for (const email of emails) next.add(email.id);
			return next;
		});
	};

	const markEmailsReadState = async (targetEmails: Email[], read: boolean) => {
		if (!mailboxId || targetEmails.length === 0) return;
		await Promise.all(targetEmails.map((email) => {
			if (read && email.thread_id && email.thread_count && email.thread_count > 1) {
				return markThreadRead.mutateAsync({ mailboxId, threadId: email.thread_id });
			}
			return updateEmail.mutateAsync({ mailboxId, id: email.id, data: { read } });
		}));
		setSelectedIds(new Set());
	};

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const selectedEmails = emails.filter((email) => selectedIds.has(email.id));
	const unreadVisibleEmails = emails.filter((email) => hasUnread(email));

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (mailboxId && hasUnread(email)) {
			if (email.thread_id && email.thread_count && email.thread_count > 1) {
				markThreadRead.mutate({
					mailboxId,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	const formatParticipants = (email: Email): string => {
		if (email.participants) {
			const names = email.participants
				.split(",")
				.map((p) => p.trim().split("@")[0])
				.filter((name, idx, arr) => arr.indexOf(name) === idx);
			if (names.length <= 3) return names.join(", ");
			return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
		}
		return email.sender.split("@")[0];
	};

	const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
	const [cursorIndex, setCursorIndex] = useState(0);

	useEffect(() => {
		if (emails.length === 0) setCursorIndex(0);
		else if (cursorIndex >= emails.length) setCursorIndex(emails.length - 1);
	}, [emails.length]);

	useEffect(() => {
		if (selectedEmailId) {
			const idx = emails.findIndex((e) => e.id === selectedEmailId);
			if (idx !== -1) setCursorIndex(idx);
		}
	}, [selectedEmailId, emails]);

	useKeyboardShortcuts({
		onNext: () => {
			if (emails.length === 0) return;
			const nextIdx = Math.min(cursorIndex + 1, emails.length - 1);
			setCursorIndex(nextIdx);
			if (selectedEmailId !== null) {
				handleRowClick(emails[nextIdx]);
			}
		},
		onPrevious: () => {
			if (emails.length === 0) return;
			const prevIdx = Math.max(cursorIndex - 1, 0);
			setCursorIndex(prevIdx);
			if (selectedEmailId !== null) {
				handleRowClick(emails[prevIdx]);
			}
		},
		onOpen: () => {
			if (emails.length === 0) return;
			const current = emails[cursorIndex];
			if (current) handleRowClick(current);
		},
		onClose: () => {
			if (isShortcutsOpen) {
				setIsShortcutsOpen(false);
				return;
			}
			if (selectedIds.size > 0) {
				setSelectedIds(new Set());
				return;
			}
			if (selectedEmailId !== null || isComposing) {
				closePanel();
			}
		},
		onToggleSelect: () => {
			if (emails.length === 0) return;
			const current = emails[cursorIndex];
			if (current) toggleSelected(current.id);
		},
		onArchive: () => {
			if (selectedIds.size > 0) {
				handleBatchMove(Folders.ARCHIVE);
			} else if (selectedEmailId && mailboxId) {
				moveEmailMut.mutate({ mailboxId, id: selectedEmailId, folderId: Folders.ARCHIVE });
				closePanel();
			} else if (emails[cursorIndex] && mailboxId) {
				moveEmailMut.mutate({ mailboxId, id: emails[cursorIndex].id, folderId: Folders.ARCHIVE });
			}
		},
		onDelete: () => {
			if (selectedIds.size > 0) {
				handleBatchDelete();
			} else if (selectedEmailId && mailboxId) {
				if (isTrashFolder) {
					if (window.confirm("Permanently delete this email? This cannot be undone.")) {
						deleteEmail.mutate({ mailboxId, id: selectedEmailId });
						closePanel();
					}
				} else {
					moveEmailMut.mutate({ mailboxId, id: selectedEmailId, folderId: Folders.TRASH });
					closePanel();
				}
			} else if (emails[cursorIndex] && mailboxId) {
				if (isTrashFolder) {
					if (window.confirm("Permanently delete this email? This cannot be undone.")) {
						deleteEmail.mutate({ mailboxId, id: emails[cursorIndex].id });
					}
				} else {
					moveEmailMut.mutate({ mailboxId, id: emails[cursorIndex].id, folderId: Folders.TRASH });
				}
			}
		},
		onToggleStar: () => {
			if (selectedIds.size > 0) {
				const anyUnstarred = selectedEmails.some((e) => !e.starred);
				handleBatchStar(anyUnstarred);
			} else if (selectedEmailId && mailboxId) {
				const current = emails.find((e) => e.id === selectedEmailId);
				if (current) updateEmail.mutate({ mailboxId, id: current.id, data: { starred: !current.starred } });
			} else if (emails[cursorIndex] && mailboxId) {
				const current = emails[cursorIndex];
				updateEmail.mutate({ mailboxId, id: current.id, data: { starred: !current.starred } });
			}
		},
		onToggleRead: () => {
			if (selectedIds.size > 0) {
				const anyUnread = selectedEmails.some((e) => hasUnread(e));
				void markEmailsReadState(selectedEmails, anyUnread);
			} else if (selectedEmailId && mailboxId) {
				const current = emails.find((e) => e.id === selectedEmailId);
				if (current) updateEmail.mutate({ mailboxId, id: current.id, data: { read: !current.read } });
			} else if (emails[cursorIndex] && mailboxId) {
				const current = emails[cursorIndex];
				updateEmail.mutate({ mailboxId, id: current.id, data: { read: !current.read } });
			}
		},
		onCompose: () => {
			startCompose();
		},
		onToggleHelp: () => {
			setIsShortcutsOpen((prev) => !prev);
		},
	});

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
				{/* Folder header */}
				<div className="flex flex-col gap-3 px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
					<div className="min-w-0">
						<h1 className="text-lg font-semibold text-kumo-default truncate">
							{status === "all" ? folderName : `${status === "unread" ? "Unread" : "Starred"} ${folderName.toLowerCase()}`}
						</h1>
					</div>
					<form onSubmit={handleSearchSubmit} className="flex min-w-0 gap-2">
						<div className="min-w-0 flex-1">
							<Input
								aria-label="Search mailbox"
								placeholder="Search mail"
								size="sm"
								value={searchInput}
								onChange={(event) => setSearchInput(event.target.value)}
							/>
						</div>
						<Button type="submit" variant="secondary" size="sm">
							Search
						</Button>
						{q && (
							<Button type="button" variant="ghost" size="sm" onClick={() => setFilter({ q: "" })}>
								Clear
							</Button>
						)}
					</form>
					<div className="flex flex-wrap items-center gap-2">
						<div className="flex rounded-md border border-kumo-line bg-kumo-base p-0.5">
							{(["all", "unread", "starred"] as const).map((item) => (
								<button
									key={item}
									type="button"
									onClick={() => setFilter({ status: item })}
									className={`rounded px-3 py-1 text-sm transition-colors ${status === item ? "bg-kumo-fill font-semibold text-kumo-default" : "text-kumo-strong hover:bg-kumo-tint"}`}
								>
									{item === "all" ? "All" : item === "unread" ? "Unread" : "Starred"}
								</button>
							))}
						</div>
						{totalCount > 0 && (
							<span className="text-sm text-kumo-subtle mr-2 hidden sm:inline">
								{totalCount} conversation{totalCount !== 1 ? "s" : ""}
							</span>
						)}
						{isTrashFolder && totalCount > 0 && (
							<Button
								variant="secondary"
								size="sm"
								icon={<TrashIcon size={14} className="text-kumo-danger" />}
								onClick={handleEmptyTrash}
								loading={emptyTrashMut.isPending}
							>
								Empty Trash
							</Button>
						)}
						<Tooltip
							content={isRefreshing ? "Refreshing..." : "Refresh"}
							side="bottom"
							asChild
						>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={
									<ArrowsClockwiseIcon
										size={18}
										className={isRefreshing ? "animate-spin" : ""}
									/>
								}
								onClick={handleRefresh}
								disabled={isRefreshing}
								aria-label="Refresh"
							/>
						</Tooltip>
						<Tooltip content="Keyboard shortcuts (?)" side="bottom" asChild>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={<CommandIcon size={18} />}
								onClick={() => setIsShortcutsOpen(true)}
								aria-label="Keyboard shortcuts"
							/>
						</Tooltip>
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-2 border-b border-kumo-line bg-kumo-recessed px-4 py-2 md:px-5">
					<label className="flex items-center gap-2 text-sm text-kumo-strong">
						<input
							type="checkbox"
							checked={allVisibleSelected}
							onChange={toggleAllVisible}
							aria-label="Select all visible emails"
						/>
						<span>{selectedCount > 0 ? `${selectedCount} selected` : "Select page"}</span>
					</label>
					{selectedCount > 0 && (
						<>
							{isTrashFolder ? (
								<>
									<Button
										variant="secondary"
										size="sm"
										icon={<ArrowCounterClockwiseIcon size={14} />}
										onClick={handleBatchRestore}
										loading={batchMoveMut.isPending}
									>
										Restore
									</Button>
									<Button
										variant="secondary"
										size="sm"
										icon={<TrashIcon size={14} className="text-kumo-danger" />}
										onClick={handleBatchDelete}
										loading={batchDeleteMut.isPending}
									>
										Delete permanently
									</Button>
								</>
							) : (
								<>
									<Button
										variant="secondary"
										size="sm"
										icon={<TrashIcon size={14} />}
										onClick={handleBatchDelete}
										loading={batchMoveMut.isPending}
									>
										Move to trash
									</Button>
									<Button
										variant="secondary"
										size="sm"
										icon={<ArchiveIcon size={14} />}
										onClick={() => handleBatchMove(Folders.ARCHIVE)}
										loading={batchMoveMut.isPending}
									>
										Archive
									</Button>
								</>
							)}
							<Button
								variant="secondary"
								size="sm"
								icon={<EnvelopeOpenIcon size={14} />}
								onClick={() => void markEmailsReadState(selectedEmails, true)}
							>
								Mark read
							</Button>
							<Button
								variant="secondary"
								size="sm"
								icon={<EnvelopeSimpleIcon size={14} />}
								onClick={() => void markEmailsReadState(selectedEmails, false)}
							>
								Mark unread
							</Button>
							<Button
								variant="secondary"
								size="sm"
								icon={<StarIcon size={14} />}
								onClick={() => handleBatchStar(true)}
							>
								Star
							</Button>
						</>
					)}
					{selectedCount === 0 && (
						<Button
							variant="secondary"
							size="sm"
							disabled={unreadVisibleEmails.length === 0}
							onClick={() => void markEmailsReadState(unreadVisibleEmails, true)}
						>
							Mark page read
						</Button>
					)}
					{selectedCount > 0 && (
						<Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
							Clear
						</Button>
					)}
				</div>

				{/* Email rows */}
				<div className="flex-1 overflow-y-auto">
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : emails.length > 0 ? (
						<div>
							{emails.map((email) => {
								const isSelected = selectedEmailId === email.id;
								const snippet = email.match_excerpt || getSnippetText(email.snippet);
								return (
									<div
										key={email.id}
										role="button"
										tabIndex={0}
										onClick={() => handleRowClick(email)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												handleRowClick(email);
											}
										}}
										className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors border-b border-kumo-line px-4 py-2.5 md:px-6 md:py-3 ${
											isPanelOpen ? "md:px-4 md:py-2.5" : ""
										} ${isSelected ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
									>
										{/* Unread dot */}
										<input
											type="checkbox"
											checked={selectedIds.has(email.id)}
											onClick={(e) => e.stopPropagation()}
											onChange={() => toggleSelected(email.id)}
											aria-label={`Select ${email.subject || "email"}`}
											className="shrink-0"
										/>
										<div className="w-2.5 shrink-0 flex justify-center">
											{hasUnread(email) && (
												<div className="h-2 w-2 rounded-full bg-kumo-brand" />
											)}
										</div>

										{/* Star */}
										<button
											type="button"
											className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
											onClick={(e) => {
												e.stopPropagation();
												toggleStar(e, email);
											}}
										>
											<StarIcon
												size={16}
												weight={email.starred ? "fill" : "regular"}
												className={
													email.starred
														? "text-kumo-warning"
														: "text-kumo-subtle hover:text-kumo-warning"
												}
											/>
										</button>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span
													className={`truncate text-sm ${hasUnread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}
												>
													{formatParticipants(email)}
												</span>
												{(email.thread_count ?? 1) > 1 && (
													<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
														{email.thread_count}
													</span>
												)}
												{email.has_draft && (
													<span className="shrink-0 text-xs text-kumo-destructive font-medium">
														Draft
													</span>
												)}
												{email.needs_reply && !email.has_draft && (
													<Tooltip content="Needs reply" asChild>
														<span className="shrink-0 text-kumo-warning">
															<ArrowBendUpLeftIcon size={14} weight="bold" />
														</span>
													</Tooltip>
												)}
												<span className="text-sm text-kumo-subtle shrink-0 ml-auto">
													{formatListDate(email.date)}
												</span>
											</div>
											<div className="truncate text-sm mt-0.5">
												<span
													className={hasUnread(email) ? "font-medium text-kumo-default" : "text-kumo-subtle"}
												>
													{highlightSearch(email.subject, q)}
												</span>
											{snippet && (
												<span className="text-kumo-subtle font-normal">
													{" "}&mdash; {highlightSearch(snippet, q)}
												</span>
											)}
										</div>
										<SearchMatchLabel fields={email.match_fields} />
										<EmailQuickActions
												email={email}
											compact
											stopPropagation
											className="mt-1"
										/>
									</div>

										{/* Row actions */}
										<div className="flex items-center shrink-0 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
											<Tooltip content={email.read ? "Mark unread" : "Mark read"} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={email.read ? <EnvelopeSimpleIcon size={14} /> : <EnvelopeOpenIcon size={14} />}
													onClick={(e) => {
														e.stopPropagation();
														if (mailboxId)
															updateEmail.mutate({
																mailboxId,
																id: email.id,
																data: { read: !email.read },
															});
													}}
													aria-label={email.read ? "Mark unread" : "Mark read"}
												/>
											</Tooltip>
											{isTrashFolder ? (
												<>
													<Tooltip content="Restore to Inbox" asChild>
														<Button
															variant="ghost"
															shape="square"
															size="sm"
															icon={<ArrowCounterClockwiseIcon size={14} />}
															onClick={(e) => handleRowRestore(e, email.id)}
															aria-label="Restore to Inbox"
														/>
													</Tooltip>
													<Tooltip content="Delete permanently" asChild>
														<Button
															variant="ghost"
															shape="square"
															size="sm"
															icon={<TrashIcon size={14} className="text-kumo-danger" />}
															onClick={(e) => handleRowDelete(e, email.id)}
															aria-label="Delete permanently"
														/>
													</Tooltip>
												</>
											) : (
												<Tooltip content="Move to trash" asChild>
													<Button
														variant="ghost"
														shape="square"
														size="sm"
														icon={<TrashIcon size={14} />}
														onClick={(e) => handleRowDelete(e, email.id)}
														aria-label="Move to trash"
													/>
												</Tooltip>
											)}
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<FolderEmptyState
							folder={folder}
							onCompose={() => startCompose()}
						/>
					)}
				</div>

				{/* Pagination */}
				{totalCount > PAGE_SIZE && (
					<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
						<Pagination
							page={page}
							setPage={setPage}
							perPage={PAGE_SIZE}
							totalCount={totalCount}
						/>
					</div>
				)}

				<KeyboardShortcutsDialog
					open={isShortcutsOpen}
					onOpenChange={setIsShortcutsOpen}
				/>
		</MailboxSplitView>
	);
}
