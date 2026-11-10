interface QuickEmailMetadataInput {
	subject?: string | null;
	text?: string | null;
	html?: string | null;
}

export interface QuickEmailMetadata {
	auth_code: string | null;
	quick_link: string | null;
}

const CODE_LABEL = "(?:\\b(?:code|passcode|otp)\\b|m[aã])";
const CODE_VALUE = "(?:\\d{4}[ -]\\d{4}|(?:\\d[ -]){3,7}\\d|\\d{4,8})";
const QUICK_LINK_POSITIVE =
	/(verify|verification|confirm|activate|login|sign[ -]?in|auth|magic|password|reset|otp|token|challenge)/i;
const QUICK_LINK_NEGATIVE =
	/(unsubscribe|privacy|terms|preferences|support|help|tracking|pixel|logo|image|avatar|facebook|twitter|linkedin)/i;

function decodeEntities(value: string): string {
	return value
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(html: string): string {
	return decodeEntities(
		html
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<br\s*\/?\s*>/gi, "\n")
			.replace(/<\/p>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

function normalizeCodeCandidate(value: string): string | null {
	const normalized = value.replace(/[\s-]+/g, "").trim();
	if (!/^\d{4,8}$/.test(normalized)) return null;
	return normalized;
}

function extractAuthCode(input: QuickEmailMetadataInput): string | null {
	const subject = input.subject || "";
	const bodyText = [input.text || "", input.html ? stripHtml(input.html) : ""]
		.filter(Boolean)
		.join("\n");
	const haystack = decodeEntities(`${subject}\n${bodyText}`)
		.replace(/https?:\/\/[^\s<>"']+/gi, " ")
		.slice(0, 40_000);
	const labeledPatterns = [
		new RegExp(`${CODE_LABEL}[ \\t]*(?:(?:is|:|=|-)[ \\t]*)?(?:\\n[ \\t]*)?(?<!\\d)(${CODE_VALUE})(?!\\d)`, "gi"),
		new RegExp(`(?<!\\d)(${CODE_VALUE})(?!\\d)[ \\t]*(?:is[ \\t]+)?(?:your[ \\t]+)?${CODE_LABEL}`, "gi"),
	];

	const candidates = new Set<string>();
	for (const pattern of labeledPatterns) {
		for (const match of haystack.matchAll(pattern)) {
			const code = normalizeCodeCandidate(match[1] || "");
			if (code) candidates.add(code);
		}
	}
	// A numeric block is a fallback only in an email explicitly about a code.
	if (new RegExp(CODE_LABEL, "i").test(`${subject}\n${bodyText.slice(0, 2000)}`)) {
		const html = (input.html || "").slice(0, 40_000).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
		for (const match of html.matchAll(/>(?:\s|&nbsp;)*(\d{4,8})(?:\s|&nbsp;)*<\//gi)) candidates.add(match[1]);
		if (candidates.size === 0) {
			for (const line of (input.text || "").slice(0, 40_000).split(/\r?\n/)) {
				if (/^\s*\d{4,8}\s*$/.test(line)) candidates.add(line.trim());
			}
		}
	}
	return candidates.size === 1 ? [...candidates][0] : null;
}

function cleanUrlCandidate(value: string): string {
	return decodeEntities(value)
		.trim()
		.replace(/[)\].,;!?]+$/g, "");
}

function normalizeUrl(value: string): string | null {
	const candidate = cleanUrlCandidate(value);
	if (candidate.length > 2048) return null;
	try {
		const url = new URL(candidate);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.toString();
	} catch {
		return null;
	}
}

function collectLinks(input: QuickEmailMetadataInput): string[] {
	const links: string[] = [];
	const html = input.html || "";
	const text = [input.subject || "", input.text || "", stripHtml(html)].join("\n");

	for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
		const url = normalizeUrl(match[1] || "");
		if (url) links.push(url);
	}

	for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
		const url = normalizeUrl(match[0] || "");
		if (url) links.push(url);
	}

	return [...new Set(links)];
}

function scoreLink(url: string): number {
	const lower = url.toLowerCase();
	if (QUICK_LINK_NEGATIVE.test(lower)) return -100;
	let score = 0;
	if (QUICK_LINK_POSITIVE.test(lower)) score += 20;
	if (lower.includes("utm_")) score -= 1;
	return score;
}

function extractQuickLink(input: QuickEmailMetadataInput): string | null {
	const links = collectLinks(input);
	if (links.length === 0) return null;

	let best: { url: string; score: number } | null = null;
	const anchorLabels = new Map<string, string>();
	for (const match of (input.html || "").matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi)) {
		const url = normalizeUrl(match[1] || "");
		if (url) anchorLabels.set(url, stripHtml(match[2] || ""));
	}
	for (const url of links) {
		let score = scoreLink(url);
		if (score < 0) continue;
		if (QUICK_LINK_POSITIVE.test(anchorLabels.get(url) || "")) score += 20;
		if (score <= 0) continue;
		if (!best || score > best.score) best = { url, score };
	}

	return best?.url || null;
}

export function metadataFromStoredEmail(subject: string | null | undefined, body: string | null | undefined): QuickEmailMetadata {
	const value = body || "";
	const html = value.length > 40_000 ? value.slice(0, 40_000).replace(/\S+$/, "") : value;
	return extractQuickEmailMetadata({ subject, html });
}

export function extractQuickEmailMetadata(input: QuickEmailMetadataInput): QuickEmailMetadata {
	return {
		auth_code: extractAuthCode(input),
		quick_link: extractQuickLink(input),
	};
}
