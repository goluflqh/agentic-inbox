interface QuickEmailMetadataInput {
	subject?: string | null;
	text?: string | null;
	html?: string | null;
}

export interface QuickEmailMetadata {
	auth_code: string | null;
	quick_link: string | null;
}

const CODE_LABEL =
	"(?:\\b(?:verification\\s+code|security\\s+code|login\\s+code|sign[ -]?in\\s+code|signup\\s+code|sign[ -]?up\\s+code|access\\s+code|confirmation\\s+code|auth(?:entication)?\\s+code|temporary\\s+(?:[A-Za-z0-9_-]+\\s+){0,2}code|one[ -]?time\\s+(?:password|passcode|code)|code|passcode|otp|pin)(?!\\s+(?:snippets?|examples?|samples?|blocks?|owners?|review|base|repository|repositories|repo|editor|changes?))\\b|m[aã](?:\\s+(?:x[aá]c\\s+(?:nh[aậ]n|minh|th[uự]c)|đ[aă]ng\\s+nh[aậ]p|b[aả]o\\s+m[aậ]t|otp|code))?)";
const AUTH_CODE_CONTEXT_RE =
	/(?:\b(?:(?:verification|verify|security|login|sign[ -]?in|signup|sign[ -]?up|access|confirmation|confirm|auth(?:entication)?|temporary|reset|recovery|2fa|mfa|single[ -]?use|one[ -]?time)[ \t]+(?:[A-Za-z0-9_-]+[ \t]+){0,2}(?:code|passcode|pin)|passcode|otp|one[ -]?time[ \t]+(?:password|passcode|code)|(?:your|the|this|enter|use|input|copy|share|request(?:ed)?)[ \t]+(?:(?:verification|verify|security|login|sign[ -]?in|signup|sign[ -]?up|access|confirmation|confirm|auth(?:entication)?|temporary|reset|recovery|2fa|mfa|single[ -]?use|one[ -]?time)[ \t]+)?code(?!\s+(?:snippets?|examples?|samples?|blocks?|owners?|review|base|repository|repositories|repo|editor|changes?|with\b|in\b))|code[ \t]+(?:is|expires|valid|to[ \t]+(?:log[ \t]*in|sign[ \t]*in|sign[ \t]*up|verify|confirm|continue)))\b|m[aã][ \t]+(?:x[aá]c[ \t]+(?:nh[aậ]n|minh|th[uự]c)|đ[aă]ng[ \t]+nh[aậ]p|b[aả]o[ \t]+m[aậ]t|otp|code)|^[ \t]*(?:otp|code|verification|verify)[ \t]*$)/im;
const NUMERIC_CODE_VALUE = "(?:\\d{3,4}[ -]\\d{3,4}|(?:\\d[ -]){3,7}\\d|\\d{4,8})";
const ALPHANUM_CODE_VALUE = "(?:[A-Za-z0-9]{3,5}-[A-Za-z0-9]{3,5}|[A-Za-z0-9]{5,8})";
const ANY_CODE_VALUE = `(?:${NUMERIC_CODE_VALUE}|${ALPHANUM_CODE_VALUE})`;

const QUICK_LINK_POSITIVE =
	/(verify|verification|confirm|activate|login|sign[ -]?in|auth|magic|password|reset|otp|token|challenge)/i;
const QUICK_LINK_NEGATIVE =
	/(unsubscribe|privacy|terms|preferences|support|help|tracking|pixel|logo|image|avatar|facebook|twitter|linkedin)/i;

const BLOCK_TAG_RE =
	/<\/?(?:p|div|br|tr|td|th|table|tbody|thead|tfoot|li|ul|ol|h[1-6]|blockquote|pre|code|section|article|header|footer|main|aside|hr)\b[^>]*>/gi;
const INLINE_UNWRAP_RE = /<\/?(?:b|strong|i|em|u|span|font|small|big|mark|sub|sup|tt|kbd|samp)\b[^>]*>/gi;

const COMMON_STOP_WORDS = new Set([
	"code", "codes", "passcode", "otp", "pin", "token", "login", "signin", "signup",
	"verify", "verification", "confirm", "confirmation", "security", "temporary",
	"access", "account", "email", "address", "number", "expires", "expire", "expired",
	"minutes", "minute", "seconds", "second", "hours", "hour", "valid", "within",
	"please", "enter", "below", "above", "ignore", "request", "requested", "anyone",
	"share", "never", "hello", "thank", "thanks", "support", "team", "system",
	"device", "browser", "session", "magic", "button", "click", "using", "change",
	"reset", "password", "update", "updates", "notion", "google", "github", "gitlab",
	"openai", "cloudflare", "microsoft", "apple", "amazon", "discord", "slack",
	"action", "status", "result", "detail", "details", "notice", "warning", "urgent",
	"important", "welcome", "success", "failed", "failure", "pending", "active",
	"cancel", "delete", "remove", "submit", "continue", "proceed", "return", "logout",
	"privacy", "policy", "service", "contact", "company", "rights", "reserved",
	"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
	"january", "february", "march", "april", "august", "october",
]);

const CSS_PROP_OR_UNIT_RE =
	/^(?:[0-9]+(?:\.[0-9]+)?(?:px|pt|pc|em|rem|vh|vw|vmin|vmax|ch|ex|cm|mm|in|deg|rad|turn|s|ms|fr)|[0-9]{1,2}h[0-9]{1,2}m?|[0-9]+(?:min|mins|sec|secs|hr|hrs|day|days|am|pm))$/i;
const HEX_COLOR_RE = /^[0-9a-f]{6}$/i;
const MODEL_OR_TECH_TOKEN_RE =
	/^(?:utf-?8|utf-?16|iso-?\d+|sha-?\d+|md5|aes-?\d+|rsa-?\d+|tls-?\d+|ipv[46]|http[123]|html5|css3|es20\d\d|win(?:32|64)|x86_?64|arm64|amd64|oauth2?|base64|uint\d+|int\d+|float\d+|gpt-?\d\w*|claude\d*)$/i;

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (entity, code) => {
			const num = Number(code);
			return num > 0 && num <= 0x10ffff && !(num >= 0xd800 && num <= 0xdfff)
				? String.fromCodePoint(num)
				: entity;
		})
		.replace(/&#x([0-9a-f]+);/gi, (entity, code) => {
			const num = parseInt(code, 16);
			return num > 0 && num <= 0x10ffff && !(num >= 0xd800 && num <= 0xdfff)
				? String.fromCodePoint(num)
				: entity;
		});
}

function cleanHtmlSource(html: string): string {
	return html
		.slice(0, 60_000)
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
		.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
}

function stripProgrammingBlocks(html: string): string {
	return cleanHtmlSource(html)
		.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, " ")
		.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (full, inner: string) => {
			const plain = decodeEntities(inner.replace(/<[^>]+>/g, " ")).trim();
			// Keep short single-token <code>123456</code> or <code>f3EMVU</code>, strip multi-token code snippets
			return plain.length <= 16 && !/[=;:{}()[\]",]/.test(plain) ? full : " ";
		});
}

function stripHtml(html: string, removeProgrammingBlocks = false): string {
	const source = removeProgrammingBlocks ? stripProgrammingBlocks(html) : cleanHtmlSource(html);
	return decodeEntities(
		source
			.replace(BLOCK_TAG_RE, "\n")
			.replace(INLINE_UNWRAP_RE, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/[ \t\f\v]+/g, " ")
			.replace(/\n[ \t]+/g, "\n")
			.replace(/\n{2,}/g, "\n")
			.trim(),
	);
}

function isProgrammingParameterOrDate(raw: string, normalized: string, contextBefore: string, contextAfter: string): boolean {
	// e.g., 2026-12-01 or 2026/12/01 around the match
	if (/^\d{4}$/.test(normalized)) {
		const year = Number(normalized);
		if (year >= 1990 && year <= 2099) {
			if (/[-/]\s*\d{1,2}\b/.test(contextAfter) || /\b\d{1,2}\s*[-/]\s*$/.test(contextBefore)) {
				return true;
			}
			if (/\b(?:on|in|year|copyright|©|since|until|from)\s*$/i.test(contextBefore)) {
				return true;
			}
		}
	}
	if (/^#[0-9a-f]{6}$/i.test(`#${raw}`) && /#\s*$/.test(contextBefore)) {
		return true;
	}
	// Reject API/SDK code snippet parameters like max_tokens=1000, "max_tokens": 1024, port: 8080, timeout = 5000
	if (
		/(?:\b(?:max_tokens|tokens|temperature|top_p|top_k|timeout|port|limit|offset|width|height|size|status|delay|retries|version|credits|price|amount|cost|total|balance)\b\s*["']?\s*[:=]\s*)$/i.test(
			contextBefore,
		) ||
		/^\s*[,;)}\]]/.test(contextAfter)
	) {
		return true;
	}
	return false;
}

function normalizeCodeCandidate(
	value: string,
	allowAlphanumeric: boolean,
	contextBefore = "",
	contextAfter = "",
): string | null {
	const raw = value.trim();
	const normalized = raw.replace(/[\s-]+/g, "").trim();
	if (normalized.length < 4 || normalized.length > 8) return null;

	if (/^\d{4,8}$/.test(normalized)) {
		if (isProgrammingParameterOrDate(raw, normalized, contextBefore, contextAfter)) return null;
		return normalized;
	}

	if (!allowAlphanumeric) return null;
	if (!/^[A-Za-z0-9]{5,8}$/.test(normalized)) return null;
	if (COMMON_STOP_WORDS.has(normalized.toLowerCase())) return null;
	if (CSS_PROP_OR_UNIT_RE.test(normalized) || MODEL_OR_TECH_TOKEN_RE.test(raw) || MODEL_OR_TECH_TOKEN_RE.test(normalized)) {
		return null;
	}
	if (HEX_COLOR_RE.test(normalized) && /#\s*$/.test(contextBefore)) {
		return null;
	}
	if (isProgrammingParameterOrDate(raw, normalized, contextBefore, contextAfter)) {
		return null;
	}

	const hasDigit = /\d/.test(normalized);
	const hasUpper = /[A-Z]/.test(normalized);
	const hasLower = /[a-z]/.test(normalized);

	// Accept mixed alphanumeric (with digits) or uppercase-only codes (5-8 chars) when in code context
	if (hasDigit && (hasUpper || hasLower)) {
		return normalized;
	}
	if (hasUpper && !hasLower && normalized.length >= 5 && normalized.length <= 8) {
		return normalized;
	}

	return null;
}

function extractAuthCode(input: QuickEmailMetadataInput): string | null {
	const subject = decodeEntities(input.subject || "").trim();
	const strippedHtml = input.html ? stripHtml(input.html, true) : "";
	const rawText = decodeEntities(input.text || "").trim();
	const bodyText = [rawText, strippedHtml].filter(Boolean).join("\n");
	const haystack = `${subject}\n${bodyText}`
		.replace(/https?:\/\/[^\s<>"']+/gi, " ")
		.slice(0, 45_000);

	// Tier 1: Direct labeled patterns (e.g. "Your sign-in code is: 734812", "Code: f3EMVU", "734812 is your verification code")
	const directForwardPatterns = [
		new RegExp(
			`${CODE_LABEL}(?:[ \\t]+(?:for|to|của|cho)[ \\t]+[^:\\n.]{1,35})?[ \\t]*(?:(?:is|là|:|=)[ \\t]*)+(?:\r?\n[ \\t]*)?(?<![A-Za-z0-9-])(${ANY_CODE_VALUE})(?![A-Za-z0-9-])`,
			"gi",
		),
		new RegExp(
			`${CODE_LABEL}[ \\t]+(?:-[ \\t]*)?(?<![A-Za-z0-9-])(${NUMERIC_CODE_VALUE})(?![A-Za-z0-9-])`,
			"gi",
		),
		new RegExp(
			`\\b(?:enter|use|input)[ \\t]+(?:the[ \\t]+|this[ \\t]+|your[ \\t]+)?${CODE_LABEL}[ \\t]+(?<![A-Za-z0-9-])(${ANY_CODE_VALUE})(?![A-Za-z0-9-])`,
			"gi",
		),
	];
	const directBackwardPattern = new RegExp(
		`(?<![A-Za-z0-9-])(${ANY_CODE_VALUE})(?![A-Za-z0-9-])[ \\t]+(?:is|là)[ \\t]+(?:your[ \\t]+|the[ \\t]+)?(?:[A-Za-z]+[ \\t]+){0,2}${CODE_LABEL}`,
		"gi",
	);

	const tier1Candidates = new Set<string>();
	for (const pattern of directForwardPatterns) {
		for (const match of haystack.matchAll(pattern)) {
			const raw = match[1] || "";
			const idx = match.index ?? 0;
			const before = haystack.slice(Math.max(0, idx - 35), idx + match[0].indexOf(raw));
			const after = haystack.slice(idx + match[0].length, idx + match[0].length + 20);
			const code = normalizeCodeCandidate(raw, true, before, after);
			if (code) tier1Candidates.add(code);
		}
	}
	for (const match of haystack.matchAll(directBackwardPattern)) {
		const raw = match[1] || "";
		const idx = match.index ?? 0;
		const before = haystack.slice(Math.max(0, idx - 35), idx);
		const after = haystack.slice(idx + match[0].length, idx + match[0].length + 20);
		const code = normalizeCodeCandidate(raw, true, before, after);
		if (code) tier1Candidates.add(code);
	}

	if (tier1Candidates.size === 1) {
		return [...tier1Candidates][0];
	}

	// Tier 2: Standalone block/line extraction ONLY when email has explicit authentication/verification code intent
	const hasCodeContext = AUTH_CODE_CONTEXT_RE.test(`${subject}\n${bodyText.slice(0, 4000)}`);
	if (!hasCodeContext) return null;

	const tier2Numeric = new Set<string>();
	const tier2Alphanum = new Set<string>();

	const addStandaloneCandidate = (rawLine: string, before = "", after = "") => {
		const trimmed = rawLine.replace(/^[\s\u00a0*•👉>-]+|[\s\u00a0*•⬅<-]+$/g, "").trim();
		if (!trimmed || trimmed.length > 16) return;
		if (!new RegExp(`^${ANY_CODE_VALUE}$`).test(trimmed)) return;
		const code = normalizeCodeCandidate(trimmed, true, before, after);
		if (!code) return;
		if (/^\d+$/.test(code)) {
			tier2Numeric.add(code);
		} else {
			tier2Alphanum.add(code);
		}
	};

	if (input.html) {
		const cleanedHtml = stripProgrammingBlocks(input.html);
		for (const match of cleanedHtml.matchAll(/>(?:\s|&nbsp;)*([A-Za-z0-9]{3,5}[ -][A-Za-z0-9]{3,5}|(?:\d[ -]){3,7}\d|[A-Za-z0-9]{4,8})(?:\s|&nbsp;)*<\//gi)) {
			const idx = match.index ?? 0;
			const before = stripHtml(cleanedHtml.slice(Math.max(0, idx - 120), idx)).slice(-45);
			const after = stripHtml(cleanedHtml.slice(idx + match[0].length, idx + match[0].length + 60)).slice(0, 25);
			addStandaloneCandidate(decodeEntities(match[1] || ""), before, after);
		}
	}
	const lines = bodyText.slice(0, 15_000).split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const prevLine = i > 0 ? lines[i - 1].slice(-45) : "";
		const nextLine = i + 1 < lines.length ? lines[i + 1].slice(0, 25) : "";
		addStandaloneCandidate(lines[i], prevLine, nextLine);
	}

	if (tier2Numeric.size === 1 && tier2Alphanum.size === 0) {
		return [...tier2Numeric][0];
	}
	if (tier2Alphanum.size === 1 && tier2Numeric.size === 0) {
		return [...tier2Alphanum][0];
	}
	if (tier2Numeric.size === 1 && tier2Alphanum.size === 1) {
		// Prefer numeric if both exist, or alphanumeric if it has digits
		return [...tier2Numeric][0];
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
	const sliced = value.length > 40_000 ? value.slice(0, 40_000).replace(/\S+$/, "") : value;
	const looksLikeHtml = /<\/?[a-z][\s\S]*?>/i.test(sliced);
	return extractQuickEmailMetadata({
		subject,
		html: looksLikeHtml ? sliced : undefined,
		text: looksLikeHtml ? undefined : sliced,
	});
}

export function extractQuickEmailMetadata(input: QuickEmailMetadataInput): QuickEmailMetadata {
	return {
		auth_code: extractAuthCode(input),
		quick_link: extractQuickLink(input),
	};
}
