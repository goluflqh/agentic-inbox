// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Button,
	Dialog,
	Empty,
	Input,
	Select,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ArrowSquareOutIcon,
	ArrowsClockwiseIcon,
	CaretLeftIcon,
	CheckCircleIcon,
	EnvelopeIcon,
	GlobeHemisphereWestIcon,
	PaperPlaneTiltIcon,
	PlusIcon,
	ShieldCheckIcon,
	TrayIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Folders } from "shared/folders";
import { queryKeys } from "~/queries/keys";
import { useCreateMailbox, useMailboxes } from "~/queries/mailboxes";
import api from "~/services/api";

interface DnsCheckState {
	checking: boolean;
	mxOk: boolean | null;
	spfOk: boolean | null;
	dmarcOk: boolean | null;
	lastChecked?: number;
}

export function meta() {
	return [{ title: "Domain Hub - Agentic Inbox" }];
}

export default function DomainsRoute() {
	const navigate = useNavigate();
	const toastManager = useKumoToastManager();
	const { data: mailboxes = [] } = useMailboxes();
	const createMailbox = useCreateMailbox();

	const { data: configData, isLoading: isConfigLoading, refetch: refetchConfig } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: 60_000,
	});

	const domains = configData?.domains ?? [];
	const defaultProvider = configData?.defaultProvider || "resend";
	const outboundProviders = configData?.outboundProviders || {};

	const [dnsStatuses, setDnsStatuses] = useState<Record<string, DnsCheckState>>({});
	const [isCheckingAll, setIsCheckingAll] = useState(false);

	// Create mailbox state
	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	// DNS Query helper using Cloudflare DNS-over-HTTPS
	const checkDomainDns = async (domain: string): Promise<DnsCheckState> => {
		let mxOk = false;
		let spfOk = false;
		let dmarcOk = false;

		try {
			// Query MX
			const mxRes = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
				headers: { accept: "application/dns-json" },
			});
			if (mxRes.ok) {
				const data = (await mxRes.json()) as { Answer?: Array<{ data: string }> };
				const answers = data.Answer || [];
				mxOk = answers.some((ans) => ans.data.toLowerCase().includes("cloudflare.net"));
			}
		} catch {
			mxOk = false;
		}

		try {
			// Query TXT (SPF)
			const txtRes = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`, {
				headers: { accept: "application/dns-json" },
			});
			if (txtRes.ok) {
				const data = (await txtRes.json()) as { Answer?: Array<{ data: string }> };
				const answers = data.Answer || [];
				spfOk = answers.some((ans) => ans.data.toLowerCase().includes("v=spf1"));
			}
		} catch {
			spfOk = false;
		}

		try {
			// Query DMARC TXT
			const dmarcRes = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(`_dmarc.${domain}`)}&type=TXT`, {
				headers: { accept: "application/dns-json" },
			});
			if (dmarcRes.ok) {
				const data = (await dmarcRes.json()) as { Answer?: Array<{ data: string }> };
				const answers = data.Answer || [];
				dmarcOk = answers.some((ans) => ans.data.toLowerCase().includes("v=dmarc1"));
			}
		} catch {
			dmarcOk = false;
		}

		return {
			checking: false,
			mxOk,
			spfOk,
			dmarcOk,
			lastChecked: Date.now(),
		};
	};

	const runDnsChecks = async (domainList: string[]) => {
		if (domainList.length === 0) return;
		setIsCheckingAll(true);
		const initial: Record<string, DnsCheckState> = {};
		for (const d of domainList) {
			initial[d] = { checking: true, mxOk: null, spfOk: null, dmarcOk: null };
		}
		setDnsStatuses(initial);

		const results: Record<string, DnsCheckState> = {};
		await Promise.all(
			domainList.map(async (d) => {
				const res = await checkDomainDns(d);
				results[d] = res;
				setDnsStatuses((prev) => ({ ...prev, [d]: res }));
			}),
		);
		setIsCheckingAll(false);
	};

	useEffect(() => {
		if (domains.length > 0) {
			void runDnsChecks(domains);
		}
	}, [domains.join(",")]);

	const handleOpenCreateForDomain = (domain: string) => {
		setSelectedDomain(domain);
		setNewPrefix("");
		setNewName("");
		setCreateError(null);
		setIsCreateOpen(true);
	};

	const handleCreateMailbox = async (e: React.FormEvent) => {
		e.preventDefault();
		const prefix = newPrefix.trim().toLowerCase();
		const domain = selectedDomain || domains[0];
		if (!prefix || !domain) {
			setCreateError("Please enter a username and select a domain.");
			return;
		}
		const email = `${prefix}@${domain}`;
		setIsCreating(true);
		setCreateError(null);
		try {
			const mailbox = await createMailbox.mutateAsync({
				email,
				name: newName.trim() || prefix,
			});
			toastManager.add({ title: "Mailbox created successfully" });
			setIsCreateOpen(false);
			navigate(`/mailbox/${mailbox.id}/emails/${Folders.INBOX}`);
		} catch (err) {
			setCreateError(err instanceof Error ? err.message : "Failed to create mailbox");
		} finally {
			setIsCreating(false);
		}
	};

	const mailboxesByDomain = (domain: string) =>
		mailboxes.filter((m) => m.email.toLowerCase().endsWith(`@${domain.toLowerCase()}`));

	return (
		<div className="min-h-screen bg-kumo-recessed pb-16">
			{/* Top Header */}
			<header className="sticky top-0 z-10 flex items-center justify-between border-b border-kumo-line bg-kumo-base px-4 py-3 md:px-8">
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={() => navigate("/")}
						className="flex items-center gap-1.5 text-sm text-kumo-subtle hover:text-kumo-default transition-colors cursor-pointer bg-transparent border-0 p-0"
					>
						<CaretLeftIcon size={16} />
						<span>Mailboxes</span>
					</button>
					<span className="text-kumo-line text-sm">/</span>
					<div className="flex items-center gap-2">
						<GlobeHemisphereWestIcon size={20} className="text-kumo-default" />
						<h1 className="text-lg font-semibold text-kumo-default">Domain Hub</h1>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Button
						variant="secondary"
						size="sm"
						icon={<ArrowsClockwiseIcon size={16} className={isCheckingAll ? "animate-spin" : ""} />}
						onClick={() => runDnsChecks(domains)}
						disabled={isCheckingAll || domains.length === 0}
					>
						{isCheckingAll ? "Checking DNS..." : "Refresh DNS"}
					</Button>
				</div>
			</header>

			<main className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8 space-y-8">
				{/* Overview Stats */}
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-4 shadow-xs">
						<div className="flex items-center justify-between">
							<span className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
								Configured Domains
							</span>
							<GlobeHemisphereWestIcon size={20} className="text-kumo-subtle" />
						</div>
						<div className="mt-2 text-2xl font-bold text-kumo-default">
							{domains.length}
						</div>
						<div className="mt-1 text-xs text-kumo-subtle">
							Active on Cloudflare & Worker
						</div>
					</div>

					<div className="rounded-xl border border-kumo-line bg-kumo-base p-4 shadow-xs">
						<div className="flex items-center justify-between">
							<span className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
								Total Mailboxes
							</span>
							<EnvelopeIcon size={20} className="text-kumo-subtle" />
						</div>
						<div className="mt-2 text-2xl font-bold text-kumo-default">
							{mailboxes.length}
						</div>
						<div className="mt-1 text-xs text-kumo-subtle">
							Across all active domains
						</div>
					</div>

					<div className="rounded-xl border border-kumo-line bg-kumo-base p-4 shadow-xs">
						<div className="flex items-center justify-between">
							<span className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
								Default Outbound
							</span>
							<PaperPlaneTiltIcon size={20} className="text-kumo-subtle" />
						</div>
						<div className="mt-2 text-2xl font-bold capitalize text-kumo-default">
							{defaultProvider}
						</div>
						<div className="mt-1 text-xs text-kumo-subtle">
							Global outbound relay
						</div>
					</div>

					<div className="rounded-xl border border-kumo-line bg-kumo-base p-4 shadow-xs">
						<div className="flex items-center justify-between">
							<span className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
								Inbound Routing
							</span>
							<TrayIcon size={20} className="text-kumo-subtle" />
						</div>
						<div className="mt-2 text-lg font-bold text-kumo-default">
							Worker Catch-all
						</div>
						<div className="mt-1 text-xs text-kumo-subtle">
							Cloudflare Email Routing
						</div>
					</div>
				</div>

				{/* Domains List */}
				<div className="space-y-4">
					<div className="flex items-center justify-between">
						<div>
							<h2 className="text-lg font-semibold text-kumo-default">Active Domains</h2>
							<p className="text-sm text-kumo-subtle">
								Live routing status, outbound configuration, and mailboxes per domain.
							</p>
						</div>
					</div>

					{isConfigLoading ? (
						<div className="rounded-xl border border-kumo-line bg-kumo-base p-8 text-center text-sm text-kumo-subtle">
							Loading domains configuration...
						</div>
					) : domains.length === 0 ? (
						<div className="rounded-xl border border-kumo-line bg-kumo-base p-8 text-center text-sm text-kumo-subtle">
							No domains configured in Worker environment.
						</div>
					) : (
						<div className="grid grid-cols-1 gap-6">
							{domains.map((domain) => {
								const domainMailboxes = mailboxesByDomain(domain);
								const provider = outboundProviders[domain] || defaultProvider;
								const dns = dnsStatuses[domain];

								return (
									<div
										key={domain}
										className="rounded-xl border border-kumo-line bg-kumo-base p-5 shadow-xs transition-shadow hover:shadow-sm space-y-5"
									>
										{/* Domain Card Header */}
										<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-kumo-line pb-4">
											<div className="flex items-center gap-3">
												<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-kumo-recessed text-kumo-default">
													<GlobeHemisphereWestIcon size={22} />
												</div>
												<div>
													<div className="flex items-center gap-2">
														<h3 className="text-base font-bold text-kumo-default">
															{domain}
														</h3>
														<Badge variant="secondary" className="capitalize text-xs">
															Outbound: {provider}
														</Badge>
													</div>
													<div className="text-xs text-kumo-subtle mt-0.5">
														Inbound: Catch-all to <span className="font-mono">agentic-inbox</span>
													</div>
												</div>
											</div>

											<div className="flex flex-wrap items-center gap-2">
												<Button
													variant="secondary"
													size="sm"
													icon={<PlusIcon size={14} />}
													onClick={() => handleOpenCreateForDomain(domain)}
												>
													New Mailbox
												</Button>
												<Button
													variant="ghost"
													size="sm"
													onClick={() => navigate(`/all/emails/${Folders.INBOX}?domain=${domain}`)}
												>
													View Inbox
												</Button>
											</div>
										</div>

										{/* DNS Health Checks */}
										<div>
											<div className="flex items-center justify-between mb-2">
												<span className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
													DNS & Routing Health (Cloudflare DoH)
												</span>
												{dns?.lastChecked && (
													<span className="text-xs text-kumo-subtle">
														Checked {new Date(dns.lastChecked).toLocaleTimeString()}
													</span>
												)}
											</div>
											<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
												{/* MX Check */}
												<div className="flex items-center gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs">
													{dns?.checking ? (
														<ArrowsClockwiseIcon size={16} className="animate-spin text-kumo-subtle" />
													) : dns?.mxOk ? (
														<CheckCircleIcon size={16} weight="fill" className="text-emerald-500 shrink-0" />
													) : dns?.mxOk === false ? (
														<WarningCircleIcon size={16} weight="fill" className="text-amber-500 shrink-0" />
													) : (
														<div className="h-3 w-3 rounded-full bg-kumo-line shrink-0" />
													)}
													<div className="min-w-0 flex-1 truncate">
														<span className="font-semibold text-kumo-default">MX Records: </span>
														<span className="text-kumo-subtle">
															{dns?.checking
																? "Verifying..."
																: dns?.mxOk
																	? "Cloudflare Email Routing"
																	: "Pending / Not routed"}
														</span>
													</div>
												</div>

												{/* SPF Check */}
												<div className="flex items-center gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs">
													{dns?.checking ? (
														<ArrowsClockwiseIcon size={16} className="animate-spin text-kumo-subtle" />
													) : dns?.spfOk ? (
														<CheckCircleIcon size={16} weight="fill" className="text-emerald-500 shrink-0" />
													) : dns?.spfOk === false ? (
														<WarningCircleIcon size={16} weight="fill" className="text-amber-500 shrink-0" />
													) : (
														<div className="h-3 w-3 rounded-full bg-kumo-line shrink-0" />
													)}
													<div className="min-w-0 flex-1 truncate">
														<span className="font-semibold text-kumo-default">Root SPF: </span>
														<span className="text-kumo-subtle">
															{dns?.checking
																? "Verifying..."
																: dns?.spfOk
																	? "v=spf1 configured"
																	: "Missing SPF record"}
														</span>
													</div>
												</div>

												{/* DMARC Check */}
												<div className="flex items-center gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs">
													{dns?.checking ? (
														<ArrowsClockwiseIcon size={16} className="animate-spin text-kumo-subtle" />
													) : dns?.dmarcOk ? (
														<CheckCircleIcon size={16} weight="fill" className="text-emerald-500 shrink-0" />
													) : dns?.dmarcOk === false ? (
														<WarningCircleIcon size={16} weight="fill" className="text-amber-500 shrink-0" />
													) : (
														<div className="h-3 w-3 rounded-full bg-kumo-line shrink-0" />
													)}
													<div className="min-w-0 flex-1 truncate">
														<span className="font-semibold text-kumo-default">DMARC: </span>
														<span className="text-kumo-subtle">
															{dns?.checking
																? "Verifying..."
																: dns?.dmarcOk
																	? "_dmarc policy active"
																	: "Missing _dmarc TXT"}
														</span>
													</div>
												</div>
											</div>
										</div>

										{/* Mailboxes on this domain */}
										<div>
											<div className="flex items-center justify-between mb-2">
												<span className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
													Mailboxes ({domainMailboxes.length})
												</span>
											</div>
											{domainMailboxes.length === 0 ? (
												<div className="rounded-lg border border-dashed border-kumo-line bg-kumo-recessed px-4 py-3 text-center text-xs text-kumo-subtle">
													No mailboxes created on this domain yet. Click "New Mailbox" above to add one.
												</div>
											) : (
												<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
													{domainMailboxes.map((mb) => (
														<Link
															key={mb.id}
															to={`/mailbox/${mb.id}/emails/${Folders.INBOX}`}
															className="flex items-center justify-between rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-strong transition-colors hover:border-kumo-default hover:text-kumo-default"
														>
															<div className="min-w-0 flex-1 pr-2 truncate">
																<div className="font-medium truncate">{mb.email}</div>
																<div className="text-xs text-kumo-subtle truncate">
																	{mb.inboxCount ?? 0} conversations
																</div>
															</div>
															{mb.unreadCount != null && mb.unreadCount > 0 && (
																<Badge variant="secondary" className="shrink-0 text-xs">
																	{mb.unreadCount} unread
																</Badge>
															)}
														</Link>
													))}
												</div>
											)}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* 0-Click Automated Onboarding Blueprint Guide */}
				<div className="rounded-xl border border-kumo-line bg-kumo-base p-6 shadow-xs space-y-4">
					<div className="flex items-center gap-2">
						<ShieldCheckIcon size={22} className="text-kumo-default" />
						<h2 className="text-base font-bold text-kumo-default">
							Automated Domain Onboarding Guide
						</h2>
					</div>
					<p className="text-sm text-kumo-subtle">
						Adding a new domain to Agentic Inbox is fully automated via API. Review the pre-flight checklist below:
					</p>

					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 pt-2">
						<div className="rounded-lg border border-kumo-line bg-kumo-recessed p-4 space-y-2">
							<div className="flex items-center gap-2 text-xs font-bold text-kumo-default">
								<span className="flex h-5 w-5 items-center justify-center rounded-full bg-kumo-fill text-xs font-bold">1</span>
								<span>Registrar Nameservers</span>
							</div>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Point domain NS to Cloudflare:
								<code className="mt-1 block font-mono text-[11px] text-kumo-default">bob.ns.cloudflare.com</code>
								<code className="block font-mono text-[11px] text-kumo-default">meiling.ns.cloudflare.com</code>
							</p>
						</div>

						<div className="rounded-lg border border-kumo-line bg-kumo-recessed p-4 space-y-2">
							<div className="flex items-center gap-2 text-xs font-bold text-kumo-default">
								<span className="flex h-5 w-5 items-center justify-center rounded-full bg-kumo-fill text-xs font-bold">2</span>
								<span>Cloudflare API Token</span>
							</div>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Token requires 2 permissions:
								<span className="mt-1 block text-kumo-default font-medium">Zone:DNS:Edit</span>
								<span className="block text-kumo-default font-medium">Zone:Email Routing:Edit</span>
							</p>
						</div>

						<div className="rounded-lg border border-kumo-line bg-kumo-recessed p-4 space-y-2">
							<div className="flex items-center gap-2 text-xs font-bold text-kumo-default">
								<span className="flex h-5 w-5 items-center justify-center rounded-full bg-kumo-fill text-xs font-bold">3</span>
								<span>Outbound Provider</span>
							</div>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Add domain in Resend or SMTP2GO. Resend DKIM records are automatically created in Cloudflare DNS by our script.
							</p>
						</div>

						<div className="rounded-lg border border-kumo-line bg-kumo-recessed p-4 space-y-2">
							<div className="flex items-center gap-2 text-xs font-bold text-kumo-default">
								<span className="flex h-5 w-5 items-center justify-center rounded-full bg-kumo-fill text-xs font-bold">4</span>
								<span>Worker Deployment</span>
							</div>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Worker environment variables <code className="font-mono text-[11px]">DOMAINS</code> and <code className="font-mono text-[11px]">OUTBOUND_PROVIDER_BY_DOMAIN</code> update seamlessly.
							</p>
						</div>
					</div>
				</div>
			</main>

			{/* Create Mailbox Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Create New Mailbox
					</Dialog.Title>
					<form onSubmit={handleCreateMailbox} className="space-y-4">
						<div>
							<label className="block text-xs font-semibold uppercase tracking-wider text-kumo-subtle mb-1.5">
								Email Address
							</label>
							<div className="flex items-center gap-2">
								<Input
									placeholder="e.g. contact"
									value={newPrefix}
									onChange={(e) => setNewPrefix(e.target.value)}
									required
									className="flex-1"
								/>
								<span className="text-kumo-subtle font-mono">@</span>
								<div className="w-48">
									<Select
										value={selectedDomain}
										onValueChange={(val) => val && setSelectedDomain(val)}
									>
										{domains.map((d) => (
											<Select.Option key={d} value={d}>
												{d}
											</Select.Option>
										))}
									</Select>
								</div>
							</div>
						</div>

						<div>
							<label className="block text-xs font-semibold uppercase tracking-wider text-kumo-subtle mb-1.5">
								Display Name (Optional)
							</label>
							<Input
								placeholder="e.g. Contact Support"
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
							/>
						</div>

						{createError && (
							<p className="text-xs text-kumo-destructive">{createError}</p>
						)}

						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" disabled={isCreating}>
										Cancel
									</Button>
								)}
							/>
							<Button type="submit" variant="primary" loading={isCreating}>
								Create Mailbox
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
