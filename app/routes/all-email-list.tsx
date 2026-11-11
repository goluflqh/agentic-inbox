// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Pagination, Select, Tooltip } from "@cloudflare/kumo";
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
	StarIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { formatListDate } from "shared/dates";
import { Folders } from "shared/folders";
import EmailQuickActions from "~/components/EmailQuickActions";
import { highlightSearch, SearchMatchLabel } from "~/components/SearchMatch";
import MailboxSplitView from "~/components/MailboxSplitView";
import KeyboardShortcutsDialog from "~/components/KeyboardShortcutsDialog";
import { useKeyboardShortcuts } from "~/hooks/useKeyboardShortcuts";
import { useUIStore } from "~/hooks/useUIStore";
import { localDateBounds } from "~/lib/date-range";
import { getSnippetText } from "~/lib/utils";
import {
	useAllEmails,
	useBatchDeleteEmails,
	useBatchMoveEmails,
	useDeleteEmail,
	useEmptyAllTrash,
	useMarkThreadRead,
	useMoveEmail,
	useUpdateEmail,
} from "~/queries/emails";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import type { Email } from "~/types";

const PAGE_SIZE = 25;

const FOLDER_LABELS: Record<string, string> = {
	[Folders.INBOX]: "Inbox",
	[Folders.SENT]: "Sent",
	[Folders.DRAFT]: "Drafts",
	[Folders.ARCHIVE]: "Archive",
	[Folders.TRASH]: "Trash",
};

const FOLDER_ICONS: Record<string, React.ReactNode> = {
	[Folders.INBOX]: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
	[Folders.SENT]: <PaperPlaneTiltIcon size={48} weight="thin" className="text-kumo-subtle" />,
	[Folders.DRAFT]: <FileIcon size={48} weight="thin" className="text-kumo-subtle" />,
	[Folders.ARCHIVE]: <ArchiveIcon size={48} weight="thin" className="text-kumo-subtle" />,
	[Folders.TRASH]: <TrashIcon size={48} weight="thin" className="text-kumo-subtle" />,
};

function AllEmailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-20 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function AllFolderEmptyState({ folder }: { folder?: string }) {
	const label = folder ? FOLDER_LABELS[folder] || folder : "Inbox";
	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{folder ? FOLDER_ICONS[folder] : FOLDER_ICONS[Folders.INBOX]}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				No emails in all {label.toLowerCase()}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs">
				Messages from every mailbox will appear here after they arrive.
			</p>
		</div>
	);
}

function hasUnread(email: Email): boolean {
	if (email.thread_unread_count !== undefined) return email.thread_unread_count > 0;
	return !email.read;
}

function formatParticipants(email: Email): string {
	if (email.participants) {
		const names = email.participants
			.split(",")
			.map((p) => p.trim().split("@")[0])
			.filter((name, idx, arr) => arr.indexOf(name) === idx);
		if (names.length <= 3) return names.join(", ");
		return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
	}
	return email.sender.split("@")[0];
}

function emailSelectionKey(email: Email): string {
	return `${email.mailbox_id || ""}:${email.id}`;
}

export default function AllEmailListRoute() {
	const { folder } = useParams<{ folder: string }>();
	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
	const [selectedMailbox, setSelectedMailbox] = useState<{ id: string; mailboxId: string } | null>(null);
	const [searchParams, setSearchParams] = useSearchParams();
	const [pageSize, setPageSize] = useState<number>(() => {
		const paramLimit = Number(searchParams.get("limit"));
		if (Number.isSafeInteger(paramLimit) && paramLimit > 0) return Math.min(paramLimit, 250);
		if (typeof window !== "undefined") {
			const saved = Number(localStorage.getItem("emails_page_size"));
			if (Number.isSafeInteger(saved) && saved > 0) return Math.min(saved, 250);
		}
		return 50;
	});

	const handlePageSizeChange = (newSize: number) => {
		setPageSize(newSize);
		if (typeof window !== "undefined") {
			localStorage.setItem("emails_page_size", String(newSize));
		}
		const params = new URLSearchParams(searchParams);
		params.delete("page");
		params.set("limit", String(newSize));
		setSearchParams(params);
	};

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

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
	});
	const domains = configData?.domains ?? [];
	const domain = searchParams.get("domain") || "all";
	const statusParam = searchParams.get("status");
	const status = statusParam === "unread" || statusParam === "starred" ? statusParam : "all";
	const q = searchParams.get("q") || "";
	const dateFrom = searchParams.get("from_date") || "";
	const dateTo = searchParams.get("to_date") || "";
	const dateBounds = localDateBounds(dateFrom, dateTo);
	const [searchInput, setSearchInput] = useState(q);

	useEffect(() => {
		setSearchInput(q);
	}, [q]);

	const setFilter = (next: { domain?: string; status?: "all" | "unread" | "starred"; q?: string; fromDate?: string; toDate?: string }) => {
		const params = new URLSearchParams(searchParams);
		const nextDomain = next.domain ?? domain;
		const nextStatus = next.status ?? status;
		const nextQ = next.q ?? q;
		params.delete("page");
		if (nextDomain === "all") params.delete("domain");
		else params.set("domain", nextDomain);
		if (nextStatus === "all") params.delete("status");
		else params.set("status", nextStatus);
		if (nextQ.trim()) params.set("q", nextQ.trim());
		else params.delete("q");
		for (const [key, value] of [["from_date", next.fromDate], ["to_date", next.toDate]] as const) {
			if (value === undefined) continue;
			if (value) params.set(key, value); else params.delete(key);
		}
		setSearchParams(params);
	};

	const handleSearchSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		setFilter({ q: searchInput });
	};

	const params = useMemo(() => {
		const next: Record<string, string> = {
			folder: folder || Folders.INBOX,
			page: String(page),
			limit: String(pageSize),
		};
		if (domain !== "all") next.domain = domain;
		if (status !== "all") next.status = status;
		if (q) next.q = q;
		if (dateBounds?.start) next.date_start = dateBounds.start;
		if (dateBounds?.end) next.date_end = dateBounds.end;
		return next;
	}, [domain, folder, page, pageSize, q, status, dateFrom, dateTo]);

	const { data: emailData, isFetching: isRefreshing, isError } = useAllEmails(params, {
		enabled: dateBounds !== null,
		refetchInterval: 30_000,
	});
	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;
	const selectedEmail = emails.find((email) => email.id === selectedEmailId);
	const panelMailboxId = selectedEmail?.mailbox_id ?? (selectedMailbox?.id === selectedEmailId ? selectedMailbox.mailboxId : undefined);
	const folderName = folder ? FOLDER_LABELS[folder] || folder : "Inbox";
	const statusName = status === "unread" ? "Unread" : status === "starred" ? "Starred" : "All";
	const title = status === "all" ? `All ${folderName.toLowerCase()}` : `${statusName} ${folderName.toLowerCase()}`;
	const isPanelOpen = selectedEmailId !== null || isComposing;
	const prevFolderRef = useRef(`${folder}/${domain}/${status}/${q}/${dateFrom}/${dateTo}`);

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${folder}/${domain}/${status}/${q}/${dateFrom}/${dateTo}`;
		prevFolderRef.current = `${folder}/${domain}/${status}/${q}/${dateFrom}/${dateTo}`;
		if (folderChanged) {
			closePanel();
			setSelectedMailbox(null);
			setSelectedKeys(new Set());
		}
	}, [closePanel, domain, folder, q, status, dateFrom, dateTo]);

	useEffect(() => {
		const visibleKeys = new Set(emails.map(emailSelectionKey));
		setSelectedKeys((current) => {
			const next = new Set([...current].filter((key) => visibleKeys.has(key)));
			return next.size === current.size ? current : next;
		});
	}, [emails]);

	const handleRefresh = () => {
		queryClient.invalidateQueries({ queryKey: ["all-emails"] });
	};

	const allVisibleSelected = emails.length > 0 && emails.every((email) => selectedKeys.has(emailSelectionKey(email)));
	const selectedCount = selectedKeys.size;
	const selectedEmails = emails.filter((email) => selectedKeys.has(emailSelectionKey(email)));
	const unreadVisibleEmails = emails.filter((email) => hasUnread(email));

	const toggleSelected = (email: Email) => {
		const key = emailSelectionKey(email);
		setSelectedKeys((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const toggleAllVisible = () => {
		setSelectedKeys((current) => {
			if (allVisibleSelected) return new Set();
			const next = new Set(current);
			for (const email of emails) next.add(emailSelectionKey(email));
			return next;
		});
	};

	const markEmailsReadState = async (targetEmails: Email[], read: boolean) => {
		const actionable = targetEmails.filter((email) => !!email.mailbox_id);
		if (actionable.length === 0) return;
		await Promise.all(actionable.map((email) => {
			const mailboxId = email.mailbox_id!;
			if (read && email.thread_id && email.thread_count && email.thread_count > 1) {
				return markThreadRead.mutateAsync({ mailboxId, threadId: email.thread_id });
			}
			return updateEmail.mutateAsync({ mailboxId, id: email.id, data: { read } });
		}));
		setSelectedKeys(new Set());
	};

	const handleRowClick = (email: Email) => {
		if (email.mailbox_id) setSelectedMailbox({ id: email.id, mailboxId: email.mailbox_id });
		selectEmail(email.id);
		const mailboxId = email.mailbox_id;
		if (!mailboxId || !hasUnread(email)) return;
		if (email.thread_id && email.thread_count && email.thread_count > 1) {
			markThreadRead.mutate({ mailboxId, threadId: email.thread_id });
		} else {
			updateEmail.mutate({ mailboxId, id: email.id, data: { read: true } });
		}
	};

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (email.mailbox_id) {
			updateEmail.mutate({
				mailboxId: email.mailbox_id,
				id: email.id,
				data: { starred: !email.starred },
			});
		}
	};

	const moveEmailMut = useMoveEmail();
	const batchMoveMut = useBatchMoveEmails();
	const batchDeleteMut = useBatchDeleteEmails();
	const emptyAllTrashMut = useEmptyAllTrash();

	const isTrashFolder = folder === Folders.TRASH;

	const handleEmptyAllTrash = async () => {
		if (!window.confirm("Bạn có chắc chắn muốn xóa vĩnh viễn toàn bộ thư trong Thùng rác của TẤT CẢ các tài khoản? Hành động này không thể hoàn tác.")) {
			return;
		}
		try {
			await emptyAllTrashMut.mutateAsync();
			closePanel();
			setSelectedKeys(new Set());
		} catch (err: any) {
			console.error("Failed to empty all trash:", err);
		}
	};

	const handleRowDelete = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (!email.mailbox_id) return;
		if (isTrashFolder) {
			const confirmed = window.confirm("Are you sure you want to permanently delete this email? This cannot be undone.");
			if (!confirmed) return;
			deleteEmail.mutate({ mailboxId: email.mailbox_id, id: email.id });
			if (selectedEmailId === email.id) closePanel();
		} else {
			moveEmailMut.mutate({ mailboxId: email.mailbox_id, id: email.id, folderId: Folders.TRASH });
			if (selectedEmailId === email.id) closePanel();
		}
	};

	const handleRowRestore = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (!email.mailbox_id) return;
		moveEmailMut.mutate({ mailboxId: email.mailbox_id, id: email.id, folderId: Folders.INBOX });
		if (selectedEmailId === email.id) closePanel();
	};

	const handleBatchDelete = async () => {
		if (selectedCount === 0) return;
		if (isTrashFolder) {
			if (!window.confirm(`Permanently delete ${selectedCount} selected email(s)? This cannot be undone.`)) return;
			const byMailbox: Record<string, string[]> = {};
			for (const em of selectedEmails) {
				if (em.mailbox_id) {
					byMailbox[em.mailbox_id] = byMailbox[em.mailbox_id] || [];
					byMailbox[em.mailbox_id].push(em.id);
				}
			}
			await Promise.all(
				Object.entries(byMailbox).map(([mbId, ids]) => batchDeleteMut.mutateAsync({ mailboxId: mbId, ids }))
			);
		} else {
			const byMailbox: Record<string, string[]> = {};
			for (const em of selectedEmails) {
				if (em.mailbox_id) {
					byMailbox[em.mailbox_id] = byMailbox[em.mailbox_id] || [];
					byMailbox[em.mailbox_id].push(em.id);
				}
			}
			await Promise.all(
				Object.entries(byMailbox).map(([mbId, ids]) => batchMoveMut.mutateAsync({ mailboxId: mbId, ids, folderId: Folders.TRASH }))
			);
		}
		setSelectedKeys(new Set());
	};

	const handleBatchRestore = async () => {
		if (selectedCount === 0) return;
		const byMailbox: Record<string, string[]> = {};
		for (const em of selectedEmails) {
			if (em.mailbox_id) {
				byMailbox[em.mailbox_id] = byMailbox[em.mailbox_id] || [];
				byMailbox[em.mailbox_id].push(em.id);
			}
		}
		await Promise.all(
			Object.entries(byMailbox).map(([mbId, ids]) => batchMoveMut.mutateAsync({ mailboxId: mbId, ids, folderId: Folders.INBOX }))
		);
		setSelectedKeys(new Set());
	};

	const handleBatchMove = async (targetFolderId: string) => {
		if (selectedCount === 0) return;
		const byMailbox: Record<string, string[]> = {};
		for (const em of selectedEmails) {
			if (em.mailbox_id) {
				byMailbox[em.mailbox_id] = byMailbox[em.mailbox_id] || [];
				byMailbox[em.mailbox_id].push(em.id);
			}
		}
		await Promise.all(
			Object.entries(byMailbox).map(([mbId, ids]) => batchMoveMut.mutateAsync({ mailboxId: mbId, ids, folderId: targetFolderId }))
		);
		setSelectedKeys(new Set());
	};

	const handleBatchStar = async (starred: boolean) => {
		if (selectedCount === 0) return;
		await Promise.all(
			selectedEmails.filter((em) => !!em.mailbox_id).map((em) => updateEmail.mutateAsync({ mailboxId: em.mailbox_id!, id: em.id, data: { starred } }))
		);
		setSelectedKeys(new Set());
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
			if (selectedKeys.size > 0) {
				setSelectedKeys(new Set());
				return;
			}
			if (selectedEmailId !== null || isComposing) {
				closePanel();
			}
		},
		onToggleSelect: () => {
			if (emails.length === 0) return;
			const current = emails[cursorIndex];
			if (current) toggleSelected(current);
		},
		onArchive: () => {
			if (selectedCount > 0) {
				void handleBatchMove(Folders.ARCHIVE);
			} else if (selectedEmailId && panelMailboxId) {
				moveEmailMut.mutate({ mailboxId: panelMailboxId, id: selectedEmailId, folderId: Folders.ARCHIVE });
				closePanel();
			} else if (emails[cursorIndex]?.mailbox_id) {
				moveEmailMut.mutate({ mailboxId: emails[cursorIndex].mailbox_id!, id: emails[cursorIndex].id, folderId: Folders.ARCHIVE });
			}
		},
		onDelete: () => {
			if (selectedCount > 0) {
				void handleBatchDelete();
			} else if (selectedEmailId && panelMailboxId) {
				if (isTrashFolder) {
					if (window.confirm("Permanently delete this email? This cannot be undone.")) {
						deleteEmail.mutate({ mailboxId: panelMailboxId, id: selectedEmailId });
						closePanel();
					}
				} else {
					moveEmailMut.mutate({ mailboxId: panelMailboxId, id: selectedEmailId, folderId: Folders.TRASH });
					closePanel();
				}
			} else if (emails[cursorIndex]?.mailbox_id) {
				if (isTrashFolder) {
					if (window.confirm("Permanently delete this email? This cannot be undone.")) {
						deleteEmail.mutate({ mailboxId: emails[cursorIndex].mailbox_id!, id: emails[cursorIndex].id });
					}
				} else {
					moveEmailMut.mutate({ mailboxId: emails[cursorIndex].mailbox_id!, id: emails[cursorIndex].id, folderId: Folders.TRASH });
				}
			}
		},
		onToggleStar: () => {
			if (selectedCount > 0) {
				const anyUnstarred = selectedEmails.some((e) => !e.starred);
				void handleBatchStar(anyUnstarred);
			} else if (selectedEmailId && panelMailboxId) {
				const current = emails.find((e) => e.id === selectedEmailId);
				if (current) updateEmail.mutate({ mailboxId: panelMailboxId, id: current.id, data: { starred: !current.starred } });
			} else if (emails[cursorIndex]?.mailbox_id) {
				const current = emails[cursorIndex];
				updateEmail.mutate({ mailboxId: current.mailbox_id!, id: current.id, data: { starred: !current.starred } });
			}
		},
		onToggleRead: () => {
			if (selectedCount > 0) {
				const anyUnread = selectedEmails.some((e) => hasUnread(e));
				void markEmailsReadState(selectedEmails, anyUnread);
			} else if (selectedEmailId && panelMailboxId) {
				const current = emails.find((e) => e.id === selectedEmailId);
				if (current) updateEmail.mutate({ mailboxId: panelMailboxId, id: current.id, data: { read: !current.read } });
			} else if (emails[cursorIndex]?.mailbox_id) {
				const current = emails[cursorIndex];
				updateEmail.mutate({ mailboxId: current.mailbox_id!, id: current.id, data: { read: !current.read } });
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
			isComposing={false}
			panelMailboxId={panelMailboxId}
			panelFolder={folder || Folders.INBOX}
		>
			<div className="flex flex-col gap-3 px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
				<div className="min-w-0">
					<h1 className="text-lg font-semibold text-kumo-default truncate">
						{title}
					</h1>
					{totalCount > 0 && (
						<div className="text-sm text-kumo-subtle">
							{totalCount} conversation{totalCount !== 1 ? "s" : ""}{domain !== "all" ? ` in ${domain}` : ""}
						</div>
					)}
				</div>
				<form onSubmit={handleSearchSubmit} className="flex min-w-0 gap-2">
					<div className="min-w-0 flex-1">
						<Input
							aria-label="Search all emails"
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
				<div className="flex flex-wrap items-end gap-3 text-sm">
					<label className="flex flex-col gap-1">From date <input type="date" value={dateFrom} onChange={(event) => setFilter({ fromDate: event.target.value })} className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1" /></label>
					<label className="flex flex-col gap-1">Through date <input type="date" value={dateTo} onChange={(event) => setFilter({ toDate: event.target.value })} className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1" /></label>
					{(dateFrom || dateTo) && <Button type="button" variant="ghost" size="sm" onClick={() => setFilter({ fromDate: "", toDate: "" })}>Clear dates</Button>}
				</div>
				<p className="text-xs text-kumo-subtle">Dates use your device's local time. Date filtering lists individual messages.</p>
				{!dateBounds && <p role="alert" className="text-sm text-kumo-destructive">Choose a valid date range; the start must not be after the end.</p>}
				<div className="flex flex-wrap items-center gap-2 shrink-0">
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
					{domains.length > 1 && (
						<div className="w-52">
							<Select
								aria-label="Domain filter"
								value={domain}
								onValueChange={(value) => {
									if (value) setFilter({ domain: value });
								}}
							>
								<Select.Option value="all">All domains</Select.Option>
								{domains.map((item) => (
									<Select.Option key={item} value={item}>
										{item}
									</Select.Option>
								))}
							</Select>
						</div>
					)}
					{isTrashFolder && totalCount > 0 && (
						<Button
							variant="secondary"
							size="sm"
							icon={<TrashIcon size={14} className="text-kumo-danger" />}
							onClick={handleEmptyAllTrash}
							loading={emptyAllTrashMut.isPending}
						>
							Empty All Trash
						</Button>
					)}
					<Tooltip content={isRefreshing ? "Refreshing..." : "Refresh"} side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowsClockwiseIcon size={18} className={isRefreshing ? "animate-spin" : ""} />}
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
					<Button variant="ghost" size="sm" onClick={() => setSelectedKeys(new Set())}>
						Clear
					</Button>
				)}
			</div>

			<div className="flex-1 overflow-y-auto">
				{!dateBounds ? null : isRefreshing && emails.length === 0 ? (
					<AllEmailListSkeleton />
				) : isError ? (
					<div role="alert" className="px-5 py-8 text-sm text-kumo-subtle">Unable to load emails. Refresh or narrow your search.</div>
				) : emails.length > 0 ? (
					<div>
						{emails.map((email) => {
							const isSelected = selectedEmailId === email.id;
							const snippet = email.match_excerpt || getSnippetText(email.snippet);
							return (
								<div
									key={`${email.mailbox_id}:${email.id}`}
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
									<input
										type="checkbox"
										checked={selectedKeys.has(emailSelectionKey(email))}
										onClick={(e) => e.stopPropagation()}
										onChange={() => toggleSelected(email)}
										aria-label={`Select ${email.subject || "email"}`}
										className="shrink-0"
									/>
									<div className="w-2.5 shrink-0 flex justify-center">
										{hasUnread(email) && <div className="h-2 w-2 rounded-full bg-kumo-brand" />}
									</div>

									<button
										type="button"
										className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
										onClick={(e) => toggleStar(e, email)}
									>
										<StarIcon
											size={16}
											weight={email.starred ? "fill" : "regular"}
											className={email.starred ? "text-kumo-warning" : "text-kumo-subtle hover:text-kumo-warning"}
										/>
									</button>

									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className={`truncate text-sm ${hasUnread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}>
												{formatParticipants(email)}
											</span>
											{(email.thread_count ?? 1) > 1 && (
												<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
													{email.thread_count}
												</span>
											)}
											{email.has_draft && (
												<span className="shrink-0 text-xs text-kumo-destructive font-medium">Draft</span>
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
											<span className={hasUnread(email) ? "font-medium text-kumo-default" : "text-kumo-subtle"}>
												{highlightSearch(email.subject, q)}
											</span>
											{snippet && <span className="text-kumo-subtle font-normal"> &mdash; {highlightSearch(snippet, q)}</span>}
										</div>
										<SearchMatchLabel fields={email.match_fields} />
										<EmailQuickActions
											email={email}
											compact
											stopPropagation
											className="mt-1"
										/>
										<div className="mt-1 flex items-center gap-1 text-xs text-kumo-subtle">
											<span className="truncate">{email.mailbox_email}</span>
											{email.mailbox_domain && <span className="shrink-0">&middot; {email.mailbox_domain}</span>}
										</div>
									</div>

									<div className="flex items-center shrink-0 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
										<Tooltip content={email.read ? "Mark unread" : "Mark read"} asChild>
											<Button
												variant="ghost"
												shape="square"
												size="sm"
												icon={email.read ? <EnvelopeSimpleIcon size={14} /> : <EnvelopeOpenIcon size={14} />}
												onClick={(e) => {
													e.stopPropagation();
													if (email.mailbox_id) {
														updateEmail.mutate({ mailboxId: email.mailbox_id, id: email.id, data: { read: !email.read } });
													}
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
														onClick={(e) => handleRowRestore(e, email)}
														aria-label="Restore to Inbox"
													/>
												</Tooltip>
												<Tooltip content="Delete permanently" asChild>
													<Button
														variant="ghost"
														shape="square"
														size="sm"
														icon={<TrashIcon size={14} className="text-kumo-danger" />}
														onClick={(e) => handleRowDelete(e, email)}
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
													onClick={(e) => handleRowDelete(e, email)}
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
					<AllFolderEmptyState folder={folder} />
				)}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-t border-kumo-line bg-kumo-base shrink-0">
				<div className="flex items-center gap-1.5 text-xs text-kumo-subtle">
					<span>Hiển thị:</span>
					{[25, 50, 100, 200].map((size) => (
						<button
							key={size}
							type="button"
							onClick={() => handlePageSizeChange(size)}
							className={`px-2 py-0.5 rounded text-xs transition-colors ${
								pageSize === size
									? "bg-kumo-fill font-semibold text-kumo-default border border-kumo-line"
									: "hover:bg-kumo-tint text-kumo-subtle hover:text-kumo-default"
							}`}
						>
							{size}
						</button>
					))}
					<span>thư / trang</span>
				</div>
				{totalCount > pageSize && (
					<div className="flex flex-col items-center gap-1">
						<Pagination
							page={page}
							setPage={setPage}
							perPage={pageSize}
							totalCount={Math.min(totalCount, 1000)}
						/>
						{totalCount > 1000 && (
							<span className="text-[10px] text-kumo-subtle">
								Showing the first 1,000 results. Narrow your search to see more.
							</span>
						)}
					</div>
				)}
			</div>

			<KeyboardShortcutsDialog
				open={isShortcutsOpen}
				onOpenChange={setIsShortcutsOpen}
			/>
		</MailboxSplitView>
	);
}
