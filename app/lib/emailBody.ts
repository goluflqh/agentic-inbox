const HTML_TAG_PATTERN =
	/<\/?(?:a|b|blockquote|body|br|div|em|font|h[1-6]|head|hr|html|i|img|li|ol|p|pre|span|strong|style|table|tbody|td|th|thead|tr|u|ul)\b[^>]*>/i;

const PLAIN_URL_PATTERN = /(https?:\/\/[^\s<>'"]+)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Formats plain-text email bodies into HTML while preserving line breaks
 * and converting http(s) URLs into clickable links.
 * Existing HTML bodies are returned unchanged.
 */
export function prepareEmailBodyForIframe(body: string): string {
	if (!body || HTML_TAG_PATTERN.test(body)) {
		return body;
	}

	const escaped = escapeHtml(body.replace(/\r\n?/g, "\n"));
	const linked = escaped.replace(PLAIN_URL_PATTERN, (rawMatch) => {
		const trailingMatch = TRAILING_PUNCTUATION.exec(rawMatch);
		const trailing = trailingMatch ? trailingMatch[0] : "";
		const cleanUrl = trailing ? rawMatch.slice(0, -trailing.length) : rawMatch;
		if (!cleanUrl) return rawMatch;
		return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
	});

	return `<div class="plain-text-email">${linked}</div>`;
}
