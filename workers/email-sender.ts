// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email sending via Resend, Brevo, SMTP2GO, or the Cloudflare Email Service binding.
 *
 * Use OUTBOUND_PROVIDER_BY_DOMAIN to route domains to providers, for example:
 * quanghuylee.cyou:resend,lequanghuy.dev:smtp2go
 * If no mapping matches, DEFAULT_OUTBOUND_PROVIDER is used, then Resend when
 * RESEND_API_KEY is configured, otherwise the Cloudflare Email binding.
 *
 * See: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 * See: https://resend.com/docs/api-reference/emails/send-email
 * See: https://developers.brevo.com/reference/sendtransacemail
 * See: https://developers.smtp2go.com/docs/send-an-email
 */

import type { Env } from "./types";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

type EmailAddress = string | { email: string; name: string };
type OutboundProvider = "resend" | "brevo" | "smtp2go" | "cloudflare";

function normalizeRecipients(value: string | string[] | undefined): string[] | undefined {
	if (!value) return undefined;
	const values = Array.isArray(value) ? value : value.split(",");
	const recipients = values.map((item) => item.trim()).filter(Boolean);
	return recipients.length > 0 ? recipients : undefined;
}

function formatAddress(address: EmailAddress): string {
	if (typeof address === "string") return address;
	const name = address.name.trim().replace(/"/g, "'");
	return name ? `"${name}" <${address.email}>` : address.email;
}

function parseAddress(address: string): { email: string; name?: string } {
	const trimmed = address.trim();
	const match = trimmed.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
	if (!match) return { email: trimmed };
	const name = match[1].trim();
	return { email: match[2].trim(), ...(name ? { name } : {}) };
}

function toBrevoAddress(address: EmailAddress): { email: string; name?: string } {
	if (typeof address === "string") return parseAddress(address);
	return { email: address.email, ...(address.name.trim() ? { name: address.name.trim() } : {}) };
}

function toBrevoRecipients(value: string | string[] | undefined): { email: string; name?: string }[] | undefined {
	const recipients = normalizeRecipients(value)?.map(parseAddress);
	return recipients && recipients.length > 0 ? recipients : undefined;
}

function senderDomain(from: EmailAddress): string | undefined {
	const email = typeof from === "string" ? parseAddress(from).email : from.email;
	return email.split("@")[1]?.trim().toLowerCase();
}

function resolveProvider(env: Env, params: SendEmailParams): OutboundProvider {
	const domain = senderDomain(params.from);
	const map = env.OUTBOUND_PROVIDER_BY_DOMAIN ?? "";
	if (domain) {
		for (const rule of map.split(",")) {
			const [rawDomain, rawProvider] = rule.split(":").map((part) => part.trim().toLowerCase());
			if ((rawDomain === domain || domain.endsWith("." + rawDomain)) && isProvider(rawProvider)) return rawProvider;
		}
	}
	const defaultProvider = (env.DEFAULT_OUTBOUND_PROVIDER ?? "").trim().toLowerCase();
	if (isProvider(defaultProvider)) return defaultProvider;
	return env.RESEND_API_KEY ? "resend" : "cloudflare";
}

function isProvider(value: string | undefined): value is OutboundProvider {
	return value === "resend" || value === "brevo" || value === "smtp2go" || value === "cloudflare";
}

function resendErrorMessage(status: number, body: unknown): string {
	if (body && typeof body === "object") {
		const record = body as Record<string, unknown>;
		const message = record.message || record.error || record.name;
		if (message) return `Resend error ${status}: ${String(message)}`;
	}
	return `Resend error ${status}`;
}

function brevoErrorMessage(status: number, body: unknown): string {
	if (body && typeof body === "object") {
		const record = body as Record<string, unknown>;
		const message = record.message || record.error || record.code;
		if (message) return `Brevo error ${status}: ${String(message)}`;
	}
	return `Brevo error ${status}`;
}

function smtp2goErrorMessage(status: number, body: unknown): string {
	if (body && typeof body === "object") {
		const record = body as Record<string, unknown>;
		const data = record.data && typeof record.data === "object"
			? record.data as Record<string, unknown>
			: undefined;
		const message = data?.error || record.error || record.message || record.request_id;
		if (message) return `SMTP2GO error ${status}: ${String(message)}`;
	}
	return `SMTP2GO error ${status}`;
}

function htmlToPlainText(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function withPlainTextFallback(params: SendEmailParams): SendEmailParams {
	if (params.text || !params.html) return params;
	const text = htmlToPlainText(params.html);
	return text ? { ...params, text } : params;
}

async function sendWithResend(
	apiKey: string,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const payload: Record<string, unknown> = {
		from: formatAddress(params.from),
		to: normalizeRecipients(params.to),
		subject: params.subject,
	};

	if (params.html) payload.html = params.html;
	if (params.text) payload.text = params.text;
	if (params.cc) payload.cc = normalizeRecipients(params.cc);
	if (params.bcc) payload.bcc = normalizeRecipients(params.bcc);
	if (params.replyTo) payload.reply_to = formatAddress(params.replyTo);
	if (params.headers && Object.keys(params.headers).length > 0) payload.headers = params.headers;
	if (params.attachments && params.attachments.length > 0) {
		payload.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			content_type: att.type,
			...(att.contentId ? { content_id: att.contentId } : {}),
		}));
	}

	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	let responseBody: unknown = null;
	try {
		responseBody = await response.json();
	} catch {
		responseBody = await response.text().catch(() => null);
	}

	if (!response.ok) {
		throw new Error(resendErrorMessage(response.status, responseBody));
	}

	const id = responseBody && typeof responseBody === "object"
		? String((responseBody as Record<string, unknown>).id || "")
		: "";
	return { messageId: id || crypto.randomUUID() };
}

async function sendWithBrevo(
	apiKey: string,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const payload: Record<string, unknown> = {
		sender: toBrevoAddress(params.from),
		to: toBrevoRecipients(params.to),
		subject: params.subject,
	};

	if (params.html) payload.htmlContent = params.html;
	if (params.text) payload.textContent = params.text;
	if (params.cc) payload.cc = toBrevoRecipients(params.cc);
	if (params.bcc) payload.bcc = toBrevoRecipients(params.bcc);
	if (params.replyTo) payload.replyTo = toBrevoAddress(params.replyTo);
	if (params.headers && Object.keys(params.headers).length > 0) payload.headers = params.headers;
	if (params.attachments && params.attachments.length > 0) {
		payload.attachment = params.attachments.map((att) => ({
			content: att.content,
			name: att.filename,
			...(att.contentId ? { contentId: att.contentId } : {}),
		}));
	}

	const response = await fetch("https://api.brevo.com/v3/smtp/email", {
		method: "POST",
		headers: {
			"api-key": apiKey,
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	let responseBody: unknown = null;
	try {
		responseBody = await response.json();
	} catch {
		responseBody = await response.text().catch(() => null);
	}

	if (!response.ok) {
		throw new Error(brevoErrorMessage(response.status, responseBody));
	}

	const id = responseBody && typeof responseBody === "object"
		? String((responseBody as Record<string, unknown>).messageId || "")
		: "";
	return { messageId: id || crypto.randomUUID() };
}

async function sendWithSmtp2go(
	apiKey: string,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const customHeaders: { header: string; value: string }[] = [];
	if (params.replyTo) customHeaders.push({ header: "Reply-To", value: formatAddress(params.replyTo) });
	if (params.headers) {
		for (const [header, value] of Object.entries(params.headers)) {
			customHeaders.push({ header, value });
		}
	}

	const payload: Record<string, unknown> = {
		api_key: apiKey,
		sender: formatAddress(params.from),
		to: normalizeRecipients(params.to),
		subject: params.subject,
	};

	if (params.html) payload.html_body = params.html;
	if (params.text) payload.text_body = params.text;
	if (params.cc) payload.cc = normalizeRecipients(params.cc);
	if (params.bcc) payload.bcc = normalizeRecipients(params.bcc);
	if (customHeaders.length > 0) payload.custom_headers = customHeaders;
	if (params.attachments && params.attachments.length > 0) {
		payload.attachments = params.attachments.map((att) => ({
			filename: att.filename,
			fileblob: att.content,
			mimetype: att.type,
		}));
	}

	const response = await fetch("https://api.smtp2go.com/v3/email/send", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	let responseBody: unknown = null;
	try {
		responseBody = await response.json();
	} catch {
		responseBody = await response.text().catch(() => null);
	}

	const data = responseBody && typeof responseBody === "object"
		? (responseBody as Record<string, unknown>).data as Record<string, unknown> | undefined
		: undefined;
	const succeeded = data?.succeeded;
	if (!response.ok || (typeof succeeded === "number" && succeeded < 1)) {
		throw new Error(smtp2goErrorMessage(response.status, responseBody));
	}

	const emailIds = Array.isArray(data?.email_id) ? data.email_id : [];
	const id = emailIds.length > 0 ? String(emailIds[0]) : "";
	return { messageId: id || crypto.randomUUID() };
}

async function sendWithCloudflare(
	binding: SendEmail,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const message: Record<string, unknown> = {
		to: params.to,
		from: params.from,
		subject: params.subject,
	};

	if (params.html) message.html = params.html;
	if (params.text) message.text = params.text;
	if (params.cc) message.cc = params.cc;
	if (params.bcc) message.bcc = params.bcc;
	if (params.replyTo) message.replyTo = params.replyTo;

	if (params.headers && Object.keys(params.headers).length > 0) {
		message.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		message.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			type: att.type,
			disposition: att.disposition,
			...(att.contentId ? { contentId: att.contentId } : {}),
		}));
	}

	const result = await binding.send(message as any);
	return { messageId: result.messageId };
}

/**
 * Send an email using the provider selected for the sender domain.
 *
 * @param env    - Worker environment with EMAIL binding and optional RESEND_API_KEY
 * @param params - Email parameters (to, from, subject, body, etc.)
 * @returns The send result with messageId
 * @throws On validation or delivery errors (error has `.code` property)
 */
export async function sendEmail(
	env: Env,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const deliverabilityParams = withPlainTextFallback(params);
	const provider = resolveProvider(env, deliverabilityParams);
	if (provider === "resend") {
		if (!env.RESEND_API_KEY) throw new Error("Resend API key is not configured");
		return sendWithResend(env.RESEND_API_KEY, deliverabilityParams);
	}
	if (provider === "brevo") {
		if (!env.BREVO_API_KEY) throw new Error("Brevo API key is not configured");
		return sendWithBrevo(env.BREVO_API_KEY, deliverabilityParams);
	}
	if (provider === "smtp2go") {
		if (!env.SMTP2GO_API_KEY) throw new Error("SMTP2GO API key is not configured");
		return sendWithSmtp2go(env.SMTP2GO_API_KEY, deliverabilityParams);
	}
	return sendWithCloudflare(env.EMAIL, deliverabilityParams);
}
