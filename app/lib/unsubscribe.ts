// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "~/types";

export interface UnsubscribeInfo {
	url: string;
	mailto?: string | null;
	isOneClick: boolean;
	source: "header" | "body";
}

/**
 * Extracts unsubscribe information from raw_headers or HTML body.
 * Always prioritizes web (HTTP) links over mailto links so clicking
 * the Unsubscribe button opens directly in the browser instead of failing
 * silently or triggering mail client popup issues.
 */
export function detectUnsubscribe(email: Email): UnsubscribeInfo | null {
	let headerHttpUrl: string | null = null;
	let headerMailto: string | null = null;
	let isOneClick = false;

	// 1. Try parsing from raw_headers (RFC 2369 / RFC 8058)
	if (email.raw_headers) {
		try {
			const headers = JSON.parse(email.raw_headers);
			let listUnsubscribeVal = "";

			if (Array.isArray(headers)) {
				for (const h of headers) {
					const key = String(h.key || h.name || "").toLowerCase();
					if (key === "list-unsubscribe") {
						listUnsubscribeVal = String(h.value || "");
					}
					if (key === "list-unsubscribe-post" && String(h.value || "").toLowerCase().includes("one-click")) {
						isOneClick = true;
					}
				}
			} else if (typeof headers === "object" && headers !== null) {
				for (const [k, v] of Object.entries(headers)) {
					const key = k.toLowerCase();
					if (key === "list-unsubscribe") {
						listUnsubscribeVal = String(v);
					}
					if (key === "list-unsubscribe-post" && String(v).toLowerCase().includes("one-click")) {
						isOneClick = true;
					}
				}
			}

			if (listUnsubscribeVal) {
				const httpMatch = listUnsubscribeVal.match(/<(?<url>https?:\/\/[^>]+)>/i) || listUnsubscribeVal.match(/(?<url>https?:\/\/[^\s,>]+)/i);
				const mailtoMatch = listUnsubscribeVal.match(/<mailto:(?<addr>[^>]+)>/i) || listUnsubscribeVal.match(/mailto:(?<addr>[^\s,>]+)/i);

				if (httpMatch?.groups?.url) {
					headerHttpUrl = httpMatch.groups.url;
				}
				if (mailtoMatch?.groups?.addr) {
					headerMailto = `mailto:${mailtoMatch.groups.addr}`;
				}
			}
		} catch {
			// ignore JSON parse error and fallback to body scan
		}
	}

	// If header explicitly provided a web HTTP link, use that as highest priority
	if (headerHttpUrl) {
		return {
			url: headerHttpUrl,
			mailto: headerMailto,
			isOneClick,
			source: "header",
		};
	}

	// 2. Scan HTML body for web unsubscribe links (prioritized over mailto)
	if (email.body) {
		const linkRegex = /<a\s+(?:[^>]*?\s+)?href=["'](?<href>https?:\/\/[^"']+)["'][^>]*>(?<text>[\s\S]*?)<\/a>/gi;
		let match: RegExpExecArray | null;

		while ((match = linkRegex.exec(email.body)) !== null) {
			let href = match.groups?.href;
			const text = (match.groups?.text || "").replace(/<[^>]+>/g, "").toLowerCase().trim();
			if (!href) continue;

			// Clean up HTML entities in URL like &amp; -> &
			href = href.replace(/&amp;/g, "&");
			const hrefLower = href.toLowerCase();

			// Check if text or href strongly indicates an unsubscribe action
			const isUnsubText =
				text.includes("unsubscribe") ||
				text.includes("opt out") ||
				text.includes("opt-out") ||
				text.includes("hủy đăng ký") ||
				text.includes("email preferences") ||
				text.includes("notification preferences") ||
				text.includes("manage preferences") ||
				text.includes("subscription preferences");

			const isUnsubHref =
				hrefLower.includes("unsubscribe") ||
				hrefLower.includes("optout") ||
				hrefLower.includes("opt-out") ||
				hrefLower.includes("email-preferences") ||
				hrefLower.includes("manage-preferences") ||
				hrefLower.includes("/unsub") ||
				hrefLower.includes("subscription/manage");

			if (isUnsubText || isUnsubHref) {
				return {
					url: href,
					mailto: headerMailto,
					isOneClick: false,
					source: "body",
				};
			}
		}
	}

	// 3. Fallback: only if no web link was found in headers or body, use mailto
	if (headerMailto) {
		return {
			url: headerMailto,
			mailto: headerMailto,
			isOneClick,
			source: "header",
		};
	}

	return null;
}
