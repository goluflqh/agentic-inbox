// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Empty,
	Input,
	Loader,
	Pagination,
	Select,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	EnvelopeIcon,
	EnvelopeOpenIcon,
	GlobeHemisphereWestIcon,
	PlusIcon,
	StarIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link as RouterLink, useLocation, useNavigate, useSearchParams } from "react-router";
import api from "~/services/api";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";

const MAILBOX_PAGE_SIZE = 10;

export function meta() {
	return [{ title: "Agentic Inbox" }];
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams, setSearchParams] = useSearchParams();
	const [emailSearch, setEmailSearch] = useState("");
	const { data: mailboxes = [], refetch: refetchMailboxes, isFetched: mailboxesFetched } = useMailboxes();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	useEffect(() => {
		if (typeof window !== "undefined") {
			const current = `${location.pathname}${location.search}`;
			sessionStorage.setItem("last_mailboxes_url", current);
		}
	}, [location.pathname, location.search]);

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity, // config rarely changes
	});

	const domains = configData?.domains ?? [];
	const emailAddresses = configData?.emailAddresses ?? [];

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const domainFilter = searchParams.get("domain") || "all";
	const mailboxSearch = searchParams.get("mailbox") || "";
	const setMailboxFilter = (key: "domain" | "mailbox", value: string) => {
		const params = new URLSearchParams(searchParams);
		params.delete("page");
		if (!value || (key === "domain" && value === "all")) params.delete(key);
		else params.set(key, value);
		setSearchParams(params, { replace: key === "mailbox" });
	};
	const pageValue = Number(searchParams.get("page"));
	const mailboxPage = Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;
	const setMailboxPage = (page: number) => {
		const params = new URLSearchParams(searchParams);
		if (page <= 1) params.delete("page");
		else params.set("page", String(page));
		setSearchParams(params);
	};
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// Set default domain when config loads
	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) {
			setSelectedDomain(domains[0]);
		}
	}, [domains, selectedDomain]);

	// Auto-create mailboxes from config (run once when both data sources are ready)
	const autoCreateDone = useRef(false);
	useEffect(() => {
		if (autoCreateDone.current) return;
		if (emailAddresses.length === 0 || !mailboxesFetched) return;
		const existingEmails = new Set(
			mailboxes.map((m) => m.email.toLowerCase()),
		);
		const toCreate = emailAddresses.filter(
			(addr) => !existingEmails.has(addr.toLowerCase()),
		);
		if (toCreate.length === 0) {
			autoCreateDone.current = true;
			return;
		}
		autoCreateDone.current = true;
		let cancelled = false;
		Promise.all(
			toCreate.map((addr) => {
				const localPart = addr.split("@")[0] || addr;
				return api.createMailbox(addr, localPart).catch(() => {});
			}),
		).then(() => { if (!cancelled) refetchMailboxes(); });
		return () => { cancelled = true; };
	}, [emailAddresses, mailboxes, refetchMailboxes]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError("Please fill in all fields");
			return;
		}
		const email = `${newPrefix}@${selectedDomain}`;
		const name = newName || newPrefix;
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: "Mailbox created successfully!" });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to create mailbox";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: "Mailbox deleted" });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({ title: "Failed to delete mailbox", variant: "error" });
		} finally {
			setIsDeleting(false);
		}
	};

	const isConfigured = emailAddresses.length > 0;
	const mailboxByEmail = new Map(
		mailboxes.map((mailbox) => [mailbox.email.toLowerCase(), mailbox]),
	);
	const accounts = isConfigured
		? emailAddresses.map((addr) => ({
				id: addr,
				email: addr,
				name: addr.split("@")[0] || addr,
				unreadCount: mailboxByEmail.get(addr.toLowerCase())?.unreadCount ?? 0,
				inboxCount: mailboxByEmail.get(addr.toLowerCase())?.inboxCount ?? 0,
			}))
		: mailboxes;
	const filteredAccounts = domainFilter === "all"
		? accounts
		: accounts.filter((account) => account.email.toLowerCase().endsWith(`@${domainFilter}`));
	const searchedAccounts = mailboxSearch.trim()
		? filteredAccounts.filter((account) => {
				const query = mailboxSearch.trim().toLowerCase();
				return account.email.toLowerCase().includes(query) || account.name.toLowerCase().includes(query);
			})
		: filteredAccounts;
	const visibleAccounts = searchedAccounts.slice(
		(mailboxPage - 1) * MAILBOX_PAGE_SIZE,
		mailboxPage * MAILBOX_PAGE_SIZE,
	);
	const totalUnreadCount = searchedAccounts.reduce(
		(sum, account) => sum + (account.unreadCount ?? 0),
		0,
	);
	const totalInboxCount = searchedAccounts.reduce(
		(sum, account) => sum + (account.inboxCount ?? 0),
		0,
	);

	const isLoading = !configData;

	const mailboxSummary = (unreadCount = 0, inboxCount = 0) => {
		if (unreadCount > 0) {
			return `${unreadCount} unread - ${inboxCount} conversation${inboxCount === 1 ? "" : "s"}`;
		}
		return `${inboxCount} conversation${inboxCount === 1 ? "" : "s"}`;
	};

	const allInboxLink = (status?: "unread" | "starred") => {
		const params = new URLSearchParams();
		if (domainFilter !== "all") params.set("domain", domainFilter);
		if (status) params.set("status", status);
		const query = params.toString();
		return `/all/emails/inbox${query ? `?${query}` : ""}`;
	};

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8">
					<div className="flex items-center justify-between">
						<h1 className="text-2xl font-bold text-kumo-default">Mailboxes</h1>
						{!isConfigured && (
							<Button
								variant="primary"
								icon={<PlusIcon size={16} />}
								onClick={() => setIsCreateOpen(true)}
							>
								New Mailbox
							</Button>
						)}
					</div>
					{domains.length > 0 && (
						<p className="text-sm text-kumo-subtle mt-1">
							{domains.join(", ")}
						</p>
					)}
					<form className="mt-5 flex gap-2" onSubmit={(event) => {
						event.preventDefault();
						const q = emailSearch.trim();
						if (!q) return;
						const params = new URLSearchParams({ q });
						if (domainFilter !== "all") params.set("domain", domainFilter);
						navigate(`/all/emails/inbox?${params}`, {
							state: { from: `${location.pathname}${location.search}` },
						});
					}}>
						<div className="min-w-0 flex-1"><Input aria-label="Search email content" placeholder="Search email sender, subject or content" size="sm" value={emailSearch} onChange={(event) => setEmailSearch(event.target.value)} /></div>
						<Button type="submit" variant="secondary" size="sm">Search emails</Button>
					</form>
					<div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
						<Input
							aria-label="Search mailboxes"
							placeholder="Search mailboxes"
							size="sm"
							value={mailboxSearch}
							onChange={(event) => setMailboxFilter("mailbox", event.target.value)}
						/>
						{domains.length > 1 && (
							<Select
								aria-label="Domain filter"
								value={domainFilter}
								onValueChange={(value) => {
									if (value) setMailboxFilter("domain", value);
								}}
							>
								<Select.Option value="all">All domains</Select.Option>
								{domains.map((domainName) => (
									<Select.Option key={domainName} value={domainName.toLowerCase()}>
										{domainName}
									</Select.Option>
								))}
							</Select>
						)}
					</div>
				</div>

				{isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : searchedAccounts.length > 0 ? (
					<div className="space-y-3">
						<RouterLink
							to={allInboxLink()}
							state={{ from: `${location.pathname}${location.search}` }}
							className="group flex items-center gap-4 rounded-xl border border-kumo-line bg-kumo-base px-5 py-4 no-underline transition-colors hover:bg-kumo-tint"
						>
							<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-default">
								<EnvelopeIcon size={20} />
							</div>
							<div className="min-w-0 flex-1">
								<div className="text-sm font-semibold text-kumo-default truncate">
									{domainFilter === "all" ? "All inboxes" : domainFilter}
								</div>
								<div className="text-sm text-kumo-subtle">
									{searchedAccounts.length} mailbox{searchedAccounts.length === 1 ? "" : "es"} - {mailboxSummary(totalUnreadCount, totalInboxCount)}
								</div>
							</div>
							{totalUnreadCount > 0 && (
								<div className="rounded-full bg-kumo-brand px-2 py-0.5 text-xs font-semibold text-white">
									{totalUnreadCount}
								</div>
							)}
						</RouterLink>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<RouterLink
								to={allInboxLink("unread")}
								state={{ from: `${location.pathname}${location.search}` }}
								className="flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3 no-underline transition-colors hover:bg-kumo-tint"
							>
								<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-default">
									<EnvelopeOpenIcon size={18} />
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-semibold text-kumo-default">Unread</div>
									<div className="text-xs text-kumo-subtle">Needs attention</div>
								</div>
								{totalUnreadCount > 0 && (
									<div className="rounded-full bg-kumo-brand px-2 py-0.5 text-xs font-semibold text-white">
										{totalUnreadCount}
									</div>
								)}
							</RouterLink>
							<RouterLink
								to={allInboxLink("starred")}
								state={{ from: `${location.pathname}${location.search}` }}
								className="flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3 no-underline transition-colors hover:bg-kumo-tint"
							>
								<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-warning">
									<StarIcon size={18} weight="fill" />
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-semibold text-kumo-default">Starred</div>
									<div className="text-xs text-kumo-subtle">Pinned conversations</div>
								</div>
							</RouterLink>
						</div>
						<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
						{visibleAccounts.map((account, idx) => (
							<RouterLink
								key={account.id}
								to={`/mailbox/${account.id}`}
								state={{ from: `${location.pathname}${location.search}` }}
								className={`group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint ${
									idx > 0 ? "border-t border-kumo-line" : ""
								}`}
							>
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									{account.name.charAt(0).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium text-kumo-default truncate">
										{account.name}
									</div>
									<div className="text-sm text-kumo-subtle">
										{account.email}
									</div>
									<div className="mt-0.5 text-xs text-kumo-subtle">
										{mailboxSummary(account.unreadCount, account.inboxCount)}
									</div>
								</div>
								{(account.unreadCount ?? 0) > 0 && (
									<div className="rounded-full bg-kumo-brand px-2 py-0.5 text-xs font-semibold text-white">
										{account.unreadCount}
									</div>
								)}
								{!isConfigured && (
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={<TrashIcon size={16} />}
										aria-label={`Delete mailbox ${account.email}`}
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											setMailboxToDelete({
												id: account.id,
												email: account.email,
											});
											setIsDeleteOpen(true);
										}}
									/>
								)}
							</RouterLink>
						))}
						</div>
						{searchedAccounts.length > MAILBOX_PAGE_SIZE && (
							<div className="flex justify-center py-2">
								<Pagination
									page={mailboxPage}
									setPage={setMailboxPage}
									perPage={MAILBOX_PAGE_SIZE}
									totalCount={searchedAccounts.length}
								/>
							</div>
						)}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								{domainFilter === "all" ? (
									<EnvelopeIcon
										size={48}
										weight="thin"
										className="text-kumo-subtle"
									/>
								) : (
									<GlobeHemisphereWestIcon
										size={48}
										weight="thin"
										className="text-kumo-subtle"
									/>
								)}
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No mailboxes yet
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								{isConfigured
									? "Your email routing is configured but no mailboxes have been created yet. They will appear here automatically."
									: "Create a mailbox to start sending and receiving emails with your domain."}
							</p>
							{!isConfigured && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateOpen(true)}
								>
									Create Mailbox
								</Button>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						Create New Mailbox
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div>
							<span className="text-sm font-medium text-kumo-default mb-1.5 block">
								Email Address
							</span>
							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
										aria-label="Address prefix"
										placeholder="info"
										size="sm"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-kumo-subtle">@</span>
								{domains.length > 1 ? (
									<div className="flex-1">
							<Select
								aria-label="Domain"
								value={selectedDomain}
								onValueChange={(value) => {
									if (value) setSelectedDomain(value);
								}}
							>
											{domains.map((d) => (
												<Select.Option key={d} value={d}>
													{d}
												</Select.Option>
											))}
										</Select>
									</div>
								) : (
									<span className="text-sm text-kumo-subtle">
										{selectedDomain || "no domain"}
									</span>
								)}
							</div>
						</div>
						<Input
							label="Display Name (optional)"
							placeholder="Info"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
								disabled={!selectedDomain}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete Mailbox
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						? This action cannot be undone.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
