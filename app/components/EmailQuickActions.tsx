import { Button, Tooltip } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CopyIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent, SyntheticEvent } from "react";
import type { Email } from "~/types";

interface EmailQuickActionsProps {
	email: Pick<Email, "auth_code" | "quick_link">;
	compact?: boolean;
	className?: string;
	stopPropagation?: boolean;
}

function safeHttpUrl(value?: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.toString();
	} catch {
		return null;
	}
}

function fallbackCopy(text: string) {
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.select();
	document.execCommand("copy");
	document.body.removeChild(textarea);
}

export default function EmailQuickActions({
	email,
	compact,
	className = "",
	stopPropagation = false,
}: EmailQuickActionsProps) {
	const [copied, setCopied] = useState(false);
	const authCode = email.auth_code?.trim() || null;
	const quickLink = useMemo(() => safeHttpUrl(email.quick_link), [email.quick_link]);

	useEffect(() => {
		if (!copied) return;
		const timeout = window.setTimeout(() => setCopied(false), 1400);
		return () => window.clearTimeout(timeout);
	}, [copied]);

	if (!authCode && !quickLink) return null;

	const handleContainerClick = (event: SyntheticEvent) => {
		if (stopPropagation) event.stopPropagation();
	};

	const handleCopy = async (event: ReactMouseEvent) => {
		handleContainerClick(event);
		if (!authCode) return;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(authCode);
			} else {
				fallbackCopy(authCode);
			}
			setCopied(true);
		} catch {
			fallbackCopy(authCode);
			setCopied(true);
		}
	};

	return (
		<div
			className={`flex flex-wrap items-center gap-1.5 ${className}`}
			onClick={handleContainerClick}
		>
			{authCode && (
				<Tooltip content="Copy code" side="bottom" asChild>
					<Button
						type="button"
						variant={compact ? "ghost" : "secondary"}
						size="sm"
						icon={<CopyIcon size={14} />}
						onClick={handleCopy}
						aria-label={`Copy code ${authCode}`}
						className={compact ? "!h-6 !min-h-6 !px-2 text-xs" : ""}
					>
						{copied ? "Copied" : authCode}
					</Button>
				</Tooltip>
			)}
			{quickLink && (
				<Tooltip content="Open link" side="bottom" asChild>
					<a
						href={quickLink}
						target="_blank"
						rel="noopener noreferrer"
						onClick={handleContainerClick}
						className={`inline-flex items-center gap-1 rounded-md border border-kumo-line bg-kumo-base text-kumo-strong transition-colors hover:bg-kumo-tint hover:text-kumo-default ${
							compact ? "min-h-6 px-2 text-xs" : "min-h-8 px-3 text-sm"
						}`}
						aria-label="Open email link"
					>
						<ArrowSquareOutIcon size={14} />
						<span>{compact ? "Link" : "Open link"}</span>
					</a>
				</Tooltip>
			)}
		</div>
	);
}
