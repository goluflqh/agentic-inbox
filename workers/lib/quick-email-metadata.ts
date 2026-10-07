interface QuickEmailMetadataInput {
	subject?: string | null;
	text?: string | null;
	html?: string | null;
}

export interface QuickEmailMetadata {
	auth_code: string | null;
	quick_link: string | null;
}

const CODE_CONTEXT =
	/(verification|security|login|one[-\s]?time|auth(?:entication)?|2fa|otp|passcode|code|verify|m[aã]|x[aá]c minh)/i;
const CODE_LABEL =
	"(?:verification|security|login|one[-\\s]?time|auth(?:entication)?|2fa|otp|passcode|code|verify|m[aã]|x[aá]c minh)";
const QUICK_LINK_POSITIVE =
	/(verify|verification|confirm|activate|login|signin|sign-in|auth|magic|password|reset|otp|code|token|challenge|account)/i;
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
	const haystack = decodeEntities(`${subject}\n${bodyText}`).slice(0, 40_000);
	const labeledPatterns = [
		new RegExp(`${CODE_LABEL}\\D{0,80}(\\d[\\d\\s-]{2,10}\\d)`, "gi"),
		new RegExp(`(\\d[\\d\\s-]{2,10}\\d)\\D{0,60}${CODE_LABEL}`, "gi"),
	];

	for (const pattern of labeledPatterns) {
		for (const match of haystack.matchAll(pattern)) {
			const code = normalizeCodeCandidate(match[1] || "");
			if (code) return code;
		}
	}

	for (const match of haystack.matchAll(/(?<!\d)(\d{6})(?!\d)/g)) {
		const index = match.index || 0;
		const context = haystack.slice(Math.max(0, index - 80), index + 100);
		if (CODE_CONTEXT.test(context)) return match[1];
	}

	return null;
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
	for (const url of links) {
		const score = scoreLink(url);
		if (score < 0) continue;
		if (!best || score > best.score) best = { url, score };
	}

	return best?.url || null;
}

export function extractQuickEmailMetadata(input: QuickEmailMetadataInput): QuickEmailMetadata {
	return {
		auth_code: extractAuthCode(input),
		quick_link: extractQuickLink(input),
	};
}
