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
 */
export function detectUnsubscribe(email: Email): UnsubscribeInfo | null {
	// 1. Try parsing from raw_headers (RFC 2369 / RFC 8058)
	if (email.raw_headers) {
		try {
			const headers = JSON.parse(email.raw_headers);
			let listUnsubscribeVal = "";
			let isOneClick = false;

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

				const url = httpMatch?.groups?.url || (mailtoMatch ? `mailto:${mailtoMatch.groups?.addr}` : null);
				if (url) {
					return {
						url,
						mailto: mailtoMatch ? `mailto:${mailtoMatch.groups?.addr}` : null,
						isOneClick,
						source: "header",
					};
				}
			}
		} catch {
			// ignore JSON parse error and fallback to body scan
		}
	}

	// 2. Fallback: scan HTML body for unsubscribe links
	if (email.body) {
		const linkRegex = /<a\s+(?:[^>]*?\s+)?href=["'](?<href>https?:\/\/[^"']+)["'][^>]*>(?<text>[\s\S]*?)<\/a>/gi;
		let match: RegExpExecArray | null;

		while ((match = linkRegex.exec(email.body)) !== null) {
			const href = match.groups?.href;
			const text = (match.groups?.text || "").replace(/<[^>]+>/g, "").toLowerCase().trim();
			const hrefLower = (href || "").toLowerCase();

			if (!href) continue;

			// Check if text or href strongly indicates an unsubscribe action
			const isUnsubText =
				text.includes("unsubscribe") ||
				text.includes("opt out") ||
				text.includes("opt-out") ||
				text.includes("hủy đăng ký") ||
				text.includes("email preferences") ||
				text.includes("notification preferences");

			const isUnsubHref =
				hrefLower.includes("unsubscribe") ||
				hrefLower.includes("optout") ||
				hrefLower.includes("opt-out") ||
				hrefLower.includes("email-preferences") ||
				hrefLower.includes("manage-preferences");

			if (isUnsubText || isUnsubHref) {
				return {
					url: href,
					isOneClick: false,
					source: "body",
				};
			}
		}
	}

	return null;
}
