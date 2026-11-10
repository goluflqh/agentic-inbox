// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Dialog, Input, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	CaretLeftIcon,
	EnvelopeOpenIcon,
	FileIcon,
	FolderIcon,
	GlobeHemisphereWestIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	PlusIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link as RouterLink, NavLink, useLocation, useNavigate, useParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS } from "shared/folders";
import { useCreateFolder, useFolders } from "~/queries/folders";
import { useMailbox, useMailboxes } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";

const FOLDER_ICONS: Record<string, React.ReactNode> = {
	[Folders.INBOX]: <TrayIcon size={18} weight="regular" />,
	[Folders.SENT]: <PaperPlaneTiltIcon size={18} weight="regular" />,
	[Folders.DRAFT]: <FileIcon size={18} weight="regular" />,
	[Folders.ARCHIVE]: <ArchiveIcon size={18} weight="regular" />,
	[Folders.TRASH]: <TrashIcon size={18} weight="regular" />,
};

const SYSTEM_FOLDER_LINKS = [
	{ id: Folders.INBOX, label: "Inbox" },
	{ id: Folders.SENT, label: "Sent" },
	{ id: Folders.DRAFT, label: "Drafts" },
	{ id: Folders.ARCHIVE, label: "Archive" },
	{ id: Folders.TRASH, label: "Trash" },
];

interface FolderLinkProps {
	to: string;
	icon: React.ReactNode;
	label: string;
	unreadCount?: number;
	onClick?: () => void;
}

function FolderLink({
	to,
	icon,
	label,
	unreadCount,
	onClick,
}: FolderLinkProps) {
	const location = useLocation();
	const isStatusView = new URLSearchParams(location.search).has("status") && to === location.pathname;
	return (
		<NavLink
			to={to}
			state={location.state}
			onClick={onClick}
			className={({ isActive }) =>
				`flex items-center gap-3 py-2 px-3 rounded-md text-sm transition-colors ${
					isActive && !isStatusView
						? "bg-kumo-fill font-semibold text-kumo-default"
						: "text-kumo-strong hover:bg-kumo-tint"
				}`
			}
		>
			<span className="shrink-0">{icon}</span>
			<span className="truncate flex-1">{label}</span>
			{unreadCount != null && unreadCount > 0 && (
				<Badge variant="secondary">{unreadCount}</Badge>
			)}
		</NavLink>
	);
}

function ViewLink({
	to,
	icon,
	label,
	isActive,
	onClick,
}: {
	to: string;
	icon: React.ReactNode;
	label: string;
	isActive: boolean;
	onClick?: () => void;
}) {
	const location = useLocation();
	return (
		<RouterLink
			to={to}
			state={location.state}
			onClick={onClick}
			className={`flex items-center gap-3 py-2 px-3 rounded-md text-sm transition-colors ${
				isActive
					? "bg-kumo-fill font-semibold text-kumo-default"
					: "text-kumo-strong hover:bg-kumo-tint"
			}`}
		>
			<span className="shrink-0">{icon}</span>
			<span className="truncate flex-1">{label}</span>
		</RouterLink>
	);
}

export default function Sidebar() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const location = useLocation();
	const isAllMail = location.pathname.startsWith("/all/");
	const currentPathAndSearch = `${location.pathname}${location.search}`;
	const navigate = useNavigate();
	const { data: folders = [] } = useFolders(isAllMail ? undefined : mailboxId);
	const createFolderMutation = useCreateFolder();
	const { startCompose, closeSidebar } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const { data: mailboxes = [] } = useMailboxes();
	const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");

	const customFolders = useMemo(
		() =>
			folders.filter((f) => !(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id)),
		[folders],
	);

	const getUnreadCount = (folderId: string) => {
		const found = folders.find((f) => f.id === folderId);
		return found?.unreadCount || 0;
	};

	const handleCreateFolder = (e: React.FormEvent) => {
		e.preventDefault();
		if (!isAllMail && newFolderName.trim() && mailboxId) {
			createFolderMutation.mutate({ mailboxId, name: newFolderName.trim() });
			setNewFolderName("");
			setIsCreateFolderOpen(false);
		}
	};

	const displayName = useMemo(() => {
		if (isAllMail) return "All inboxes";
		if (!currentMailbox) return mailboxId?.split("@")[0] || "Mailbox";
		// Prefer settings.fromName > name > local part of email
		if (currentMailbox.settings?.fromName) {
			return currentMailbox.settings.fromName;
		}
		if (currentMailbox.name && currentMailbox.name !== currentMailbox.email) {
			return currentMailbox.name;
		}
		return currentMailbox.email.split("@")[0] || currentMailbox.name;
	}, [currentMailbox, isAllMail, mailboxId]);

	const handleNavClick = () => {
		// Close mobile sidebar on navigation
		closeSidebar();
	};

	const inboxBasePath = isAllMail
		? `/all/emails/${Folders.INBOX}`
		: `/mailbox/${mailboxId}/emails/${Folders.INBOX}`;
	const allMailDomain = isAllMail ? new URLSearchParams(location.search).get("domain") : null;
	const viewPath = (status: "unread" | "starred") => {
		const params = new URLSearchParams();
		if (allMailDomain) params.set("domain", allMailDomain);
		params.set("status", status);
		return `${inboxBasePath}?${params.toString()}`;
	};
	const unreadPath = viewPath("unread");
	const starredPath = viewPath("starred");

	const handleBack = () => {
		closeSidebar();
		const stateFrom =
			(location.state as { from?: string; returnTo?: string } | null)?.from ||
			(location.state as { from?: string; returnTo?: string } | null)?.returnTo;
		if (stateFrom && typeof stateFrom === "string" && stateFrom.startsWith("/")) {
			navigate(stateFrom);
			return;
		}

		if (typeof window !== "undefined") {
			const saved = sessionStorage.getItem("last_mailboxes_url");
			if (saved && saved.startsWith("/")) {
				navigate(saved);
				return;
			}
		}

		if (mailboxId && mailboxId.includes("@")) {
			const domain = mailboxId.split("@")[1].toLowerCase();
			navigate(`/?domain=${encodeURIComponent(domain)}`);
			return;
		}

		if (isAllMail) {
			const allMailDomain = new URLSearchParams(location.search).get("domain");
			if (allMailDomain && allMailDomain !== "all") {
				navigate(`/?domain=${encodeURIComponent(allMailDomain)}`);
				return;
			}
		}

		navigate("/");
	};


	return (
		<aside className="h-full w-64 bg-kumo-recessed flex flex-col shrink-0 border-r border-kumo-line">
			{/* Back + identity */}
			<div className="px-4 pt-4 pb-1">
				<button
					type="button"
					onClick={handleBack}
					className="flex items-center gap-1.5 text-kumo-subtle text-sm hover:text-kumo-default transition-colors mb-2.5 cursor-pointer bg-transparent border-0 p-0"
				>
					<CaretLeftIcon size={14} />
					<span>Mailboxes</span>
				</button>
				<div className="px-1">
					<div className="text-base font-semibold text-kumo-default truncate">
						{displayName}
					</div>
					<div className="text-sm text-kumo-subtle truncate mt-0.5">
						{isAllMail
							? `${mailboxes.length} mailbox${mailboxes.length === 1 ? "" : "es"}`
							: currentMailbox?.email || mailboxId}
					</div>
				</div>
			</div>

			{/* Compose */}
			{!isAllMail && <div className="px-3 py-3">
				<Button
					variant="primary"
					icon={<PencilSimpleIcon size={16} />}
					onClick={() => startCompose()}
					className="w-full"
				>
					Compose
				</Button>
			</div>}

			{/* Navigation */}
			<nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
				<div className="pb-3">
					<div className="px-3 mb-1.5 text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
						Views
					</div>
					<ViewLink
						to={unreadPath}
						icon={<EnvelopeOpenIcon size={18} weight="regular" />}
						label="Unread"
						isActive={currentPathAndSearch === unreadPath}
						onClick={handleNavClick}
					/>
					<ViewLink
						to={starredPath}
						icon={<StarIcon size={18} weight="regular" />}
						label="Starred"
						isActive={currentPathAndSearch === starredPath}
						onClick={handleNavClick}
					/>
				</div>

				{SYSTEM_FOLDER_LINKS.map((folder) => (
					<FolderLink
						key={folder.id}
						to={isAllMail ? `/all/emails/${folder.id}` : `/mailbox/${mailboxId}/emails/${folder.id}`}
						icon={FOLDER_ICONS[folder.id]}
						label={folder.label}
						unreadCount={isAllMail ? undefined : getUnreadCount(folder.id)}
						onClick={handleNavClick}
					/>
				))}

				{/* Custom folders */}
				{!isAllMail && customFolders.length > 0 && (
					<div className="pt-5">
						<div className="flex items-center justify-between px-3 mb-1.5">
							<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
								Folders
							</span>
							<Tooltip content="New folder" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateFolderOpen(true)}
									aria-label="Create new folder"
								/>
							</Tooltip>
						</div>
						{customFolders.map((folder) => (
							<FolderLink
								key={folder.id}
								to={`/mailbox/${mailboxId}/emails/${folder.id}`}
								icon={<FolderIcon size={18} />}
								label={folder.name}
								unreadCount={folder.unreadCount}
								onClick={handleNavClick}
							/>
						))}
					</div>
				)}

				{/* Add folder button when no custom folders */}
				{!isAllMail && customFolders.length === 0 && (
					<div className="pt-5">
						<div className="flex items-center justify-between px-3 mb-1.5">
							<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
								Folders
							</span>
							<Tooltip content="New folder" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateFolderOpen(true)}
									aria-label="Create new folder"
								/>
							</Tooltip>
						</div>
					</div>
				)}
			</nav>

			{/* Create folder dialog */}
			<Dialog.Root
				open={isCreateFolderOpen}
				onOpenChange={setIsCreateFolderOpen}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Create folder
					</Dialog.Title>
					<form onSubmit={handleCreateFolder} className="space-y-4">
						<Input
							label="Folder name"
							placeholder="e.g. Projects"
							value={newFolderName}
							onChange={(e) => setNewFolderName(e.target.value)}
							required
						/>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								disabled={!newFolderName.trim()}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
			{/* Domain Hub link in sidebar footer */}
			<div className="border-t border-kumo-line p-2">
				<NavLink
					to="/domains"
					onClick={handleNavClick}
					className={({ isActive }) =>
						`flex items-center gap-3 py-2 px-3 rounded-md text-sm transition-colors ${
							isActive
								? "bg-kumo-fill font-semibold text-kumo-default"
								: "text-kumo-strong hover:bg-kumo-tint"
						}`
					}
				>
					<GlobeHemisphereWestIcon size={18} />
					<span className="truncate flex-1">Domain Hub</span>
				</NavLink>
			</div>
		</aside>
	);
}
