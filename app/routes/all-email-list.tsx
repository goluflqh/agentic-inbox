// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Pagination, Select, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowsClockwiseIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
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
import MailboxSplitView from "~/components/MailboxSplitView";
import { useUIStore } from "~/hooks/useUIStore";
import { getSnippetText } from "~/lib/utils";
import {
	useAllEmails,
	useDeleteEmail,
	useMarkThreadRead,
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
	} = useUIStore();
	const [page, setPage] = useState(1);
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
	const [searchParams, setSearchParams] = useSearchParams();
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
	const [searchInput, setSearchInput] = useState(q);

	useEffect(() => {
		setSearchInput(q);
	}, [q]);

	const setFilter = (next: { domain?: string; status?: "all" | "unread" | "starred"; q?: string }) => {
		const params = new URLSearchParams(searchParams);
		const nextDomain = next.domain ?? domain;
		const nextStatus = next.status ?? status;
		const nextQ = next.q ?? q;
		if (nextDomain === "all") params.delete("domain");
		else params.set("domain", nextDomain);
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

	const params = useMemo(() => {
		const next: Record<string, string> = {
			folder: folder || Folders.INBOX,
			page: String(page),
			limit: String(PAGE_SIZE),
		};
		if (domain !== "all") next.domain = domain;
		if (status !== "all") next.status = status;
		if (q) next.q = q;
		return next;
	}, [domain, folder, page, q, status]);

	const { data: emailData, isFetching: isRefreshing } = useAllEmails(params, {
		refetchInterval: 30_000,
	});
	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;
	const selectedEmail = emails.find((email) => email.id === selectedEmailId);
	const panelMailboxId = selectedEmail?.mailbox_id;
	const folderName = folder ? FOLDER_LABELS[folder] || folder : "Inbox";
	const statusName = status === "unread" ? "Unread" : status === "starred" ? "Starred" : "All";
	const title = status === "all" ? `All ${folderName.toLowerCase()}` : `${statusName} ${folderName.toLowerCase()}`;
	const isPanelOpen = selectedEmailId !== null || isComposing;
	const prevFolderRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${folder}/${domain}/${status}/${q}`;
		prevFolderRef.current = `${folder}/${domain}/${status}/${q}`;
		if (folderChanged) {
			closePanel();
			setPage(1);
			setSelectedKeys(new Set());
		}
	}, [closePanel, domain, folder, q, status]);

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

	const handleDelete = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (!email.mailbox_id) return;
		const confirmed = window.confirm("Are you sure you want to delete this email?");
		if (!confirmed) return;
		deleteEmail.mutate({ mailboxId: email.mailbox_id, id: email.id });
		if (selectedEmailId === email.id) closePanel();
	};

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
				<Button
					variant="secondary"
					size="sm"
					disabled={selectedCount === 0}
					onClick={() => void markEmailsReadState(selectedEmails, true)}
				>
					Mark read
				</Button>
				<Button
					variant="secondary"
					size="sm"
					disabled={selectedCount === 0}
					onClick={() => void markEmailsReadState(selectedEmails, false)}
				>
					Mark unread
				</Button>
				<Button
					variant="secondary"
					size="sm"
					disabled={unreadVisibleEmails.length === 0}
					onClick={() => void markEmailsReadState(unreadVisibleEmails, true)}
				>
					Mark page read
				</Button>
				{selectedCount > 0 && (
					<Button variant="ghost" size="sm" onClick={() => setSelectedKeys(new Set())}>
						Clear
					</Button>
				)}
			</div>

			<div className="flex-1 overflow-y-auto">
				{isRefreshing && emails.length === 0 ? (
					<AllEmailListSkeleton />
				) : emails.length > 0 ? (
					<div>
						{emails.map((email) => {
							const isSelected = selectedEmailId === email.id;
							const snippet = getSnippetText(email.snippet);
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
												{email.subject}
											</span>
											{snippet && <span className="text-kumo-subtle font-normal"> &mdash; {snippet}</span>}
										</div>
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
										<Tooltip content="Delete" asChild>
											<Button
												variant="ghost"
												shape="square"
												size="sm"
												icon={<TrashIcon size={14} />}
												onClick={(e) => handleDelete(e, email)}
												aria-label="Delete"
											/>
										</Tooltip>
									</div>
								</div>
							);
						})}
					</div>
				) : (
					<AllFolderEmptyState folder={folder} />
				)}
			</div>

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
		</MailboxSplitView>
	);
}
