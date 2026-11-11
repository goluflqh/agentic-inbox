// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import { extractQuickEmailMetadata } from "./lib/quick-email-metadata";
import { fetchPrefix } from "./lib/aggregate-page";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
	getMailboxStub,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

function statusQuery(c: AppContext): "all" | "unread" | "starred" {
	const status = c.req.query("status")?.toLowerCase();
	return status === "unread" || status === "starred" ? status : "all";
}

function defaultMailboxSettings(name: string) {
	return {
		fromName: name,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
		blockedSenders: [] as string[],
	};
}

async function readMailboxSettings(env: Env, mailboxId: string): Promise<Record<string, unknown>> {
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return defaultMailboxSettings(mailboxId);
	try {
		const raw = (await obj.json()) as Record<string, unknown>;
		if (raw && typeof raw === "object") {
			const settings = ("settings" in raw && raw.settings && typeof raw.settings === "object")
				? (raw.settings as Record<string, unknown>)
				: raw;
			return { ...defaultMailboxSettings(mailboxId), ...settings };
		}
	} catch {}
	return defaultMailboxSettings(mailboxId);
}

async function writeMailboxSettings(env: Env, mailboxId: string, settings: Record<string, unknown>): Promise<void> {
	await env.BUCKET.put(`mailboxes/${mailboxId}.json`, JSON.stringify(settings));
}

const GLOBAL_BLOCKED_SENDERS_KEY = "config/global-blocked-senders.json";

async function getGlobalBlockedSenders(env: Env): Promise<string[]> {
	try {
		const obj = await env.BUCKET.get(GLOBAL_BLOCKED_SENDERS_KEY);
		if (!obj) return [];
		return (await obj.json<string[]>()) || [];
	} catch {
		return [];
	}
}

async function addGlobalBlockedSender(env: Env, sender: string): Promise<string[]> {
	const current = await getGlobalBlockedSenders(env);
	const s = sender.toLowerCase().trim();
	if (!current.includes(s)) {
		current.push(s);
		await env.BUCKET.put(GLOBAL_BLOCKED_SENDERS_KEY, JSON.stringify(current));
	}
	return current;
}

async function removeGlobalBlockedSender(env: Env, sender: string): Promise<string[]> {
	const current = await getGlobalBlockedSenders(env);
	const s = sender.toLowerCase().trim();
	const next = current.filter((x) => x !== s);
	await env.BUCKET.put(GLOBAL_BLOCKED_SENDERS_KEY, JSON.stringify(next));
	return next;
}

function isSenderBlocked(sender: string, blockedList: string[]): boolean {
	if (!sender) return false;
	const s = sender.toLowerCase().trim();
	const emailMatch = s.match(/<([^>]+)>/);
	const emailOnly = emailMatch ? emailMatch[1].toLowerCase().trim() : s;

	return (blockedList || []).some((pattern) => {
		const p = (pattern || "").toLowerCase().trim();
		if (!p) return false;
		if (p.startsWith("@")) {
			return emailOnly.endsWith(p) || s.endsWith(p);
		}
		if (emailOnly === p || s === p || s.includes(`<${p}>`)) {
			return true;
		}
		// Plus-addressing support (e.g. failed-payments+acct_xxx@stripe.com)
		if (emailOnly.includes("@") && p.includes("@")) {
			const [local, dom] = emailOnly.split("@");
			const baseLocal = local.split("+")[0];
			const [pLocal, pDom] = p.split("@");
			const pBaseLocal = pLocal.split("+")[0];
			if (dom === pDom && baseLocal === pBaseLocal && (local.includes("+") || pLocal.includes("+"))) {
				return true;
			}
		}
		return false;
	});
}

function configuredDomains(env: Env): string[] {
	return (env.DOMAINS || "")
		.split(",")
		.map((d) => d.trim().toLowerCase().replace(/^@/, ""))
		.filter(Boolean);
}

function isConfiguredDomainAddress(env: Env, email: string): boolean {
	const domain = email.split("@")[1]?.toLowerCase();
	const domains = configuredDomains(env);
	return !!domain && (domains.length === 0 || domains.some((d) => domain === d || domain.endsWith("." + d)));
}

function mailboxNameFromAddress(email: string): string {
	return email.split("@")[0] || email;
}

function mailboxDomain(email: string): string {
	return email.split("@")[1]?.toLowerCase() || "";
}

function annotateMailboxEmail<T extends Record<string, unknown>>(email: T, mailboxId: string) {
	return {
		...email,
		mailbox_id: mailboxId,
		mailbox_email: mailboxId,
		mailbox_name: mailboxNameFromAddress(mailboxId),
		mailbox_domain: mailboxDomain(mailboxId),
	} as T & {
		mailbox_id: string;
		mailbox_email: string;
		mailbox_name: string;
		mailbox_domain: string;
	};
}

async function createMailboxRecord(
	env: Env,
	email: string,
	name: string,
	settings?: Record<string, unknown>,
) {
	const key = `mailboxes/${email}.json`;
	const finalSettings = { ...defaultMailboxSettings(name), ...settings };
	await env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return finalSettings;
}

// -- App & middleware -----------------------------------------------

async function refreshQuickMetadata<T extends { id: string }>(stub: { getQuickMetadata: (ids: string[]) => Promise<{ id: string; auth_code: string | null; quick_link: string | null }[]> }, emails: T[]): Promise<T[]> {
	if (!emails.length) return emails;
	const metadata = await stub.getQuickMetadata(emails.map((email) => email.id));
	const byId = new Map(metadata.map(({ id, ...values }) => [id, values]));
	return emails.map((email) => ({ ...email, ...(byId.get(email.id) || { auth_code: null, quick_link: null }) }));
}

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	const defaultProvider = (c.env.DEFAULT_OUTBOUND_PROVIDER ?? "resend").trim().toLowerCase();
	const outboundMapRaw = c.env.OUTBOUND_PROVIDER_BY_DOMAIN ?? "";
	const outboundProviders: Record<string, string> = {};
	for (const rule of outboundMapRaw.split(",")) {
		const [d, p] = rule.split(":").map((part) => part.trim().toLowerCase());
		if (d && p) outboundProviders[d] = p;
	}
	return c.json({ domains, emailAddresses, defaultProvider, outboundProviders });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	const mailboxes = await Promise.all(
		allMailboxes.map(async (mailbox) => {
			const stub = getMailboxStub(c.env, mailbox.id) as any;
			try {
				const [folders, inboxCount] = await Promise.all([
					stub.getFolders(),
					stub.countThreadedEmails(Folders.INBOX),
				]);
				const inbox = (folders as { id: string; unreadCount?: number }[]).find(
					(folder) => folder.id === Folders.INBOX,
				);
				return {
					...mailbox,
					name: mailbox.id,
					unreadCount: inbox?.unreadCount ?? 0,
					inboxCount: Number(inboxCount) || 0,
				};
			} catch (e) {
				console.error(`Failed to load mailbox counts for ${mailbox.id}:`, (e as Error).message);
				return { ...mailbox, name: mailbox.id, unreadCount: 0, inboxCount: 0 };
			}
		}),
	);
	return c.json(mailboxes);
});

app.get("/api/v1/all-emails", async (c) => {
	const folder = c.req.query("folder") || Folders.INBOX;
	const domain = c.req.query("domain")?.toLowerCase();
	const status = statusQuery(c as AppContext);
	const q = c.req.query("q")?.trim();
	const date_start = c.req.query("date_start");
	const date_end = c.req.query("date_end");
	const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
	if ((date_start && !validDate(date_start)) || (date_end && !validDate(date_end)) || (date_start && date_end && date_start > date_end)) {
		return c.json({ error: "Invalid date range" }, 400);
	}
	const page = Math.max(intQuery(c as AppContext, "page") || 1, 1);
	const limit = Math.min(Math.max(intQuery(c as AppContext, "limit") || 25, 1), 250);
	const fetchLimit = page * limit;
	// Bound cross-mailbox fan-out; deeper pagination needs a cursor-based merge.
	if (fetchLimit > 1000) return c.json({ error: "All-inbox pagination is limited to the first 1000 results. Narrow your search or select a mailbox." }, 400);
	const offset = (page - 1) * limit;
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	const mailboxes = domain
		? allMailboxes.filter((m) => mailboxDomain(m.email) === domain)
		: allMailboxes;

	const results = await Promise.all(
		mailboxes.map(async (mailbox) => {
			const stub = getMailboxStub(c.env, mailbox.id) as any;
			try {
				if (q || date_start || date_end) {
					const searchOpts = {
						query: q,
						date_start,
						date_end,
						folder,
						is_read: status === "unread" ? false : undefined,
						is_starred: status === "starred" ? true : undefined,
					};
					const [emails, totalCount] = await Promise.all([
						fetchPrefix<Record<string, unknown>>(fetchLimit, (page, limit) => stub.searchEmails({ ...searchOpts, page, limit })),
						stub.countSearchResults(searchOpts),
					]);
					return {
						emails: (emails as Record<string, unknown>[]).map((email) =>
							annotateMailboxEmail(email, mailbox.id),
						),
						totalCount: Number(totalCount) || 0,
					};
				}
				const [emails, totalCount] = await Promise.all([
					fetchPrefix<Record<string, unknown>>(fetchLimit, (page, limit) => stub.getThreadedEmails({ folder, status, page, limit })),
					stub.countThreadedEmails(folder, status),
				]);
				return {
					emails: (emails as Record<string, unknown>[]).map((email) =>
						annotateMailboxEmail(email, mailbox.id),
					),
					totalCount: Number(totalCount) || 0,
				};
			} catch (e) {
				console.error(`Failed to aggregate mailbox ${mailbox.id}:`, (e as Error).message);
				throw e;
			}
		}),
	);

	const pageEmails = results
		.flatMap((result) => result.emails)
		.sort((a, b) => new Date(String(b.date || "")).getTime() - new Date(String(a.date || "")).getTime())
		.slice(offset, offset + limit);
	const grouped = new Map<string, typeof pageEmails>();
	for (const email of pageEmails) {
		const key = String(email.mailbox_id);
		grouped.set(key, [...(grouped.get(key) || []), email]);
	}
	const refreshed = await Promise.all([...grouped].map(async ([mailboxId, group]) => {
		const stub = getMailboxStub(c.env, mailboxId);
		return refreshQuickMetadata(stub, group.map((email) => ({ ...email, id: String(email.id) })));
	}));
	const byKey = new Map(refreshed.flat().map((email) => [`${email.mailbox_id}:${email.id}`, email]));
	const emails = pageEmails.map((email) => byKey.get(`${email.mailbox_id}:${email.id}`) || email);

	return c.json({
		emails,
		totalCount: results.reduce((sum, result) => sum + result.totalCount, 0),
	});
});

app.post("/api/v1/all-emails/mark-all-read", async (c: AppContext) => {
	try {
		const { folder } = (await c.req.json().catch(() => ({}))) as { folder?: string };
		const allMailboxes = await listMailboxes(c.env.BUCKET);
		let count = 0;
		await Promise.all(
			allMailboxes.map(async (mb) => {
				try {
					const stub = getMailboxStub(c.env, mb.id);
					const marked = await (stub as any).markAllRead(folder);
					count += marked;
				} catch (e) {
					console.error(`Failed to mark read for ${mb.id}:`, e);
				}
			}),
		);
		return c.json({ success: true, count });
	} catch (err: any) {
		console.error("Failed to mark all emails read:", err);
		return c.json({ error: err?.message || "Failed to mark all emails read" }, 500);
	}
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	if (!isConfiguredDomainAddress(c.env, email)) {
		return c.json({ error: "Mailbox domain is not configured in DOMAINS" }, 400);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const finalSettings = await createMailboxRecord(c.env, email, name, settings);
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const status = statusQuery(c);
	const q = c.req.query("q")?.trim();
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (q) {
		const searchOpts = {
			query: q,
			folder,
			is_read: status === "unread" ? false : undefined,
			is_starred: status === "starred" ? true : undefined,
		};
		const emails = await (stub as any).searchEmails({ ...searchOpts, page, limit });
		const totalCount = await (stub as any).countSearchResults(searchOpts);
		return c.json({ emails: await refreshQuickMetadata(stub, emails), totalCount });
	}

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, status, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder, status);
		return c.json({ emails: await refreshQuickMetadata(stub, emails), totalCount });
	}
	const emails = await refreshQuickMetadata(stub, await stub.getEmails({ folder, thread_id, status, page, limit, sortColumn, sortDirection }));
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id, status });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);

	let delivery: { messageId: string };
	try {
		delivery = await sendEmail(c.env, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		});
	} catch (e) {
		return c.json({ error: `Failed to send email: ${(e as Error).message}` }, 502);
	}

	try {
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);
	} catch (e) {
		console.error("Provider accepted message but Sent copy failed:", (e as Error).message);
		return c.json({ id: messageId, status: "sent_save_failed", deliveryMessageId: delivery.messageId }, 202);
	}

	return c.json({ id: messageId, status: "sent", deliveryMessageId: delivery.messageId }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/batch/delete", async (c: AppContext) => {
	const { ids } = (await c.req.json()) as { ids: string[] };
	if (!Array.isArray(ids) || ids.length === 0) return c.json({ count: 0 });
	const attachments = await (c.var.mailboxStub as any).deleteEmails(ids);
	if (attachments.length > 0) {
		await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${att.email_id}/${att.id}/${att.filename}`));
	}
	return c.json({ count: ids.length });
});

app.delete("/api/v1/mailboxes/:mailboxId/trash", async (c: AppContext) => {
	const attachments = await (c.var.mailboxStub as any).emptyTrash();
	if (attachments.length > 0) {
		await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${att.email_id}/${att.id}/${att.filename}`));
	}
	return c.json({ success: true });
});

app.delete("/api/v1/trash", async (c: AppContext) => {
	try {
		const allMailboxes = await listMailboxes(c.env.BUCKET);
		const allAttachments: any[] = [];
		await Promise.all(
			allMailboxes.map(async (mb) => {
				try {
					const stub = getMailboxStub(c.env, mb.id);
					const atts = await (stub as any).emptyTrash();
					if (Array.isArray(atts) && atts.length > 0) {
						allAttachments.push(...atts);
					}
				} catch (e) {
					console.error(`Failed to empty trash for ${mb.id}:`, e);
				}
			})
		);
		if (allAttachments.length > 0) {
			for (let i = 0; i < allAttachments.length; i += 500) {
				const batch = allAttachments.slice(i, i + 500);
				await c.env.BUCKET.delete(batch.map((att: any) => `attachments/${att.email_id}/${att.id}/${att.filename}`));
			}
		}
		return c.json({ success: true });
	} catch (err: any) {
		console.error("Failed to empty all trash:", err);
		return c.json({ error: err?.message || "Failed to empty all trash" }, 500);
	}
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/batch/move", async (c: AppContext) => {
	const { ids, folderId } = (await c.req.json()) as { ids: string[]; folderId: string };
	if (!Array.isArray(ids) || ids.length === 0) return c.json({ count: 0 });
	const success = await (c.var.mailboxStub as any).moveEmails(ids, folderId);
	return success ? c.json({ count: ids.length, status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Blocked & Allowed Senders ----------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/block-sender", async (c: AppContext) => {
	try {
		const mailboxId = c.req.param("mailboxId")!;
		const settings = await readMailboxSettings(c.env, mailboxId);
		const rawMailboxBlocked = Array.isArray(settings.blockedSenders) ? (settings.blockedSenders as string[]) : [];
		const mailboxAllowed = Array.isArray(settings.allowedSenders) ? (settings.allowedSenders as string[]) : [];
		const globalBlocked = await getGlobalBlockedSenders(c.env);
		// Deduplicate: remove from mailboxBlocked if already in globalBlocked
		const mailboxBlocked = rawMailboxBlocked.filter(
			(s) => !globalBlocked.some((g) => g.toLowerCase() === s.toLowerCase()),
		);
		return c.json({ mailboxBlocked, globalBlocked, mailboxAllowed });
	} catch (err: any) {
		console.error("Failed to get blocked senders:", err);
		return c.json({ error: err?.message || "Failed to get blocked senders" }, 500);
	}
});

app.post("/api/v1/mailboxes/:mailboxId/block-sender", async (c: AppContext) => {
	try {
		const mailboxId = c.req.param("mailboxId")!;
		const { sender, scope = "mailbox", moveToTrash = false, emailId } = (await c.req.json()) as {
			sender: string;
			scope?: "mailbox" | "global";
			moveToTrash?: boolean;
			emailId?: string;
		};

		if (!sender || !sender.trim()) {
			return c.json({ error: "Sender is required" }, 400);
		}

		const rawSender = sender.trim().toLowerCase();
		const match = rawSender.match(/<([^>]+)>/);
		const normalizedSender = match ? match[1].toLowerCase().trim() : rawSender;

		let mailboxBlocked: string[] = [];
		let globalBlocked: string[] = [];

		if (scope === "global") {
			globalBlocked = await addGlobalBlockedSender(c.env, normalizedSender);
			const settings = await readMailboxSettings(c.env, mailboxId);
			let changed = false;
			// Clean up redundant mailbox-level block if present
			if (Array.isArray(settings.blockedSenders) && settings.blockedSenders.includes(normalizedSender)) {
				settings.blockedSenders = (settings.blockedSenders as string[]).filter(
					(x) => x.toLowerCase() !== normalizedSender,
				);
				changed = true;
			}
			// Clean up allowed exception if user explicitly chooses to block globally
			if (Array.isArray(settings.allowedSenders) && settings.allowedSenders.includes(normalizedSender)) {
				settings.allowedSenders = (settings.allowedSenders as string[]).filter(
					(x) => x.toLowerCase() !== normalizedSender,
				);
				changed = true;
			}
			if (changed) {
				await writeMailboxSettings(c.env, mailboxId, settings);
			}
			mailboxBlocked = ((settings.blockedSenders as string[]) || []).filter(
				(s) => !globalBlocked.some((g) => g.toLowerCase() === s.toLowerCase()),
			);
		} else {
			const settings = await readMailboxSettings(c.env, mailboxId);
			const list = Array.isArray(settings.blockedSenders) ? [...(settings.blockedSenders as string[])] : [];
			if (!list.includes(normalizedSender)) {
				list.push(normalizedSender);
			}
			settings.blockedSenders = list;
			// Remove from allowedSenders if present
			if (Array.isArray(settings.allowedSenders)) {
				settings.allowedSenders = settings.allowedSenders.filter((x) => x.toLowerCase() !== normalizedSender);
			}
			await writeMailboxSettings(c.env, mailboxId, settings);
			globalBlocked = await getGlobalBlockedSenders(c.env);
			mailboxBlocked = list.filter(
				(s) => !globalBlocked.some((g) => g.toLowerCase() === s.toLowerCase()),
			);
		}

		let movedCount = 0;
		const mailboxCounts: Record<string, number> = {};
		if (moveToTrash) {
			// 1. Always prioritize the current active mailbox first
			try {
				const currentCount = await (c.var.mailboxStub as any).moveEmailsBySender(
					normalizedSender,
					Folders.TRASH,
					emailId,
				);
				if (currentCount > 0) {
					mailboxCounts[mailboxId] = currentCount;
					movedCount += currentCount;
				}
			} catch (err) {
				console.error(`Failed to move emails in current mailbox ${mailboxId}:`, err);
			}

			// 2. If global block, sweep other mailboxes in concurrency-safe batches
			if (scope === "global") {
				try {
					const allMailboxes = await listMailboxes(c.env.BUCKET);
					const otherMailboxes = allMailboxes.filter(
						(m) => m.id.toLowerCase() !== mailboxId.toLowerCase(),
					);
					const BATCH_SIZE = 5;
					for (let i = 0; i < otherMailboxes.length; i += BATCH_SIZE) {
						const batch = otherMailboxes.slice(i, i + BATCH_SIZE);
						await Promise.allSettled(
							batch.map(async (mb) => {
								try {
									const stub = getMailboxStub(c.env, mb.id);
									const count = await (stub as any).moveEmailsBySender(
										normalizedSender,
										Folders.TRASH,
									);
									if (count > 0) {
										mailboxCounts[mb.id] = count;
										movedCount += count;
									}
								} catch (err) {
									console.error(`Failed to move emails in mailbox ${mb.id}:`, err);
								}
							}),
						);
					}
				} catch (err) {
					console.error("Failed to sweep other mailboxes for blocked sender:", err);
				}
			}
		}

		return c.json({
			success: true,
			scope,
			sender: normalizedSender,
			movedCount,
			mailboxCounts,
			mailboxBlocked,
			globalBlocked,
		});
	} catch (err: any) {
		console.error("Failed to block sender:", err);
		return c.json({ error: err?.message || "Failed to block sender" }, 500);
	}
});

app.post("/api/v1/mailboxes/:mailboxId/allow-sender", async (c: AppContext) => {
	try {
		const mailboxId = c.req.param("mailboxId")!;
		const { sender, restoreToInbox = true } = (await c.req.json()) as {
			sender: string;
			restoreToInbox?: boolean;
		};

		if (!sender || !sender.trim()) {
			return c.json({ error: "Sender is required" }, 400);
		}

		const rawSender = sender.trim().toLowerCase();
		const match = rawSender.match(/<([^>]+)>/);
		const normalizedSender = match ? match[1].toLowerCase().trim() : rawSender;

		const settings = await readMailboxSettings(c.env, mailboxId);
		const allowed = Array.isArray(settings.allowedSenders) ? [...settings.allowedSenders] : [];
		if (!allowed.some((a) => a.toLowerCase() === normalizedSender)) {
			allowed.push(normalizedSender);
		}
		// Remove from local blockedSenders if present
		if (Array.isArray(settings.blockedSenders)) {
			settings.blockedSenders = (settings.blockedSenders as string[]).filter(
				(x) => x.toLowerCase() !== normalizedSender,
			);
		}
		settings.allowedSenders = allowed;
		await writeMailboxSettings(c.env, mailboxId, settings);

		let restoredCount = 0;
		if (restoreToInbox) {
			restoredCount = await (c.var.mailboxStub as any).moveEmailsBySender(normalizedSender, Folders.INBOX);
		}

		return c.json({
			success: true,
			sender: normalizedSender,
			allowed: settings.allowedSenders,
			restoredCount,
		});
	} catch (err: any) {
		console.error("Failed to allow sender:", err);
		return c.json({ error: err?.message || "Failed to allow sender" }, 500);
	}
});

app.delete("/api/v1/mailboxes/:mailboxId/allow-sender/:sender", async (c: AppContext) => {
	try {
		const mailboxId = c.req.param("mailboxId")!;
		const raw = decodeURIComponent(c.req.param("sender")!).trim().toLowerCase();
		const match = raw.match(/<([^>]+)>/);
		const normalizedSender = match ? match[1].toLowerCase().trim() : raw;

		const settings = await readMailboxSettings(c.env, mailboxId);
		if (Array.isArray(settings.allowedSenders)) {
			settings.allowedSenders = (settings.allowedSenders as string[]).filter(
				(x) => x.toLowerCase() !== normalizedSender,
			);
			await writeMailboxSettings(c.env, mailboxId, settings);
		}

		return c.json({ success: true, sender: normalizedSender, allowed: settings.allowedSenders || [] });
	} catch (err: any) {
		console.error("Failed to remove allowed sender:", err);
		return c.json({ error: err?.message || "Failed to remove allowed sender" }, 500);
	}
});

app.delete("/api/v1/mailboxes/:mailboxId/block-sender/:sender", async (c: AppContext) => {
	try {
		const mailboxId = c.req.param("mailboxId")!;
		const raw = decodeURIComponent(c.req.param("sender")!).trim().toLowerCase();
		const match = raw.match(/<([^>]+)>/);
		const sender = match ? match[1].toLowerCase().trim() : raw;
		const scope = c.req.query("scope") || "mailbox";

		let mailboxBlocked: string[] = [];
		let globalBlocked: string[] = [];

		if (scope === "global") {
			globalBlocked = await removeGlobalBlockedSender(c.env, sender);
			// Also remove from all individual mailboxes to ensure complete unblock across all accounts
			const allMailboxes = await listMailboxes(c.env.BUCKET);
			for (const mb of allMailboxes) {
				try {
					const mbSettings = await readMailboxSettings(c.env, mb.id);
					let changed = false;
					if (Array.isArray(mbSettings.blockedSenders) && mbSettings.blockedSenders.includes(sender)) {
						mbSettings.blockedSenders = (mbSettings.blockedSenders as string[]).filter(
							(x) => x.toLowerCase() !== sender,
						);
						changed = true;
					}
					if (Array.isArray(mbSettings.allowedSenders) && mbSettings.allowedSenders.includes(sender)) {
						mbSettings.allowedSenders = (mbSettings.allowedSenders as string[]).filter(
							(x) => x.toLowerCase() !== sender,
						);
						changed = true;
					}
					if (changed) {
						await writeMailboxSettings(c.env, mb.id, mbSettings);
					}
				} catch (e) {
					console.error(`Failed to unblock in mailbox ${mb.id}:`, e);
				}
			}
			const settings = await readMailboxSettings(c.env, mailboxId);
			mailboxBlocked = Array.isArray(settings.blockedSenders) ? (settings.blockedSenders as string[]) : [];
		} else {
			const settings = await readMailboxSettings(c.env, mailboxId);
			const list = Array.isArray(settings.blockedSenders)
				? (settings.blockedSenders as string[]).filter((x) => x !== sender)
				: [];
			settings.blockedSenders = list;
			await writeMailboxSettings(c.env, mailboxId, settings);
			mailboxBlocked = list;
			globalBlocked = await getGlobalBlockedSenders(c.env);
		}

		return c.json({ success: true, sender, mailboxBlocked, globalBlocked });
	} catch (err: any) {
		console.error("Failed to unblock sender:", err);
		return c.json({ error: err?.message || "Failed to unblock sender" }, 500);
	}
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

app.post("/api/v1/mailboxes/:mailboxId/mark-all-read", async (c: AppContext) => {
	try {
		const { folder } = (await c.req.json().catch(() => ({}))) as { folder?: string };
		const count = await (c.var.mailboxStub as any).markAllRead(folder);
		return c.json({ success: true, count });
	} catch (err: any) {
		console.error("Failed to mark all read:", err);
		return c.json({ error: err?.message || "Failed to mark all read" }, 500);
	}
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails: await refreshQuickMetadata(stub, emails), totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment || attachment.email_id !== emailId) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	const inlineImage = attachment.disposition === "inline" && /^(image\/png|image\/jpeg|image\/gif|image\/webp)$/i.test(attachment.mimetype);
	headers.set("Content-Disposition", `${inlineImage ? "inline" : "attachment"}; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	headers.set("X-Content-Type-Options", "nosniff");
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	let mailboxId: string | undefined;
	if (allowedAddresses.length > 0) {
		mailboxId = allRecipients.find((addr) => allowedAddresses.includes(addr));
		if (!mailboxId) { console.log(`Ignoring email: no recipient matches EMAIL_ADDRESSES.`); return; }
	} else { mailboxId = allRecipients[0]; }
	if (!mailboxId) throw new Error("received email with no valid recipient address");
	if (!isConfiguredDomainAddress(env, mailboxId)) { console.log(`Ignoring email for ${mailboxId}: domain is not configured`); return; }

	const messageId = crypto.randomUUID();
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		await createMailboxRecord(env, mailboxId, mailboxNameFromAddress(mailboxId));
		console.log(`Auto-created mailbox for inbound email: ${mailboxId}`);
	}

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;
	const quickMetadata = extractQuickEmailMetadata({
		subject: parsedEmail.subject || "",
		text: parsedEmail.text || "",
		html: parsedEmail.html || "",
	});

	const senderAddress = (parsedEmail.from?.address || "").toLowerCase();

	let targetFolder: string = Folders.INBOX;
	try {
		const settings = await readMailboxSettings(env, mailboxId);
		const mailboxBlocked = Array.isArray(settings.blockedSenders) ? (settings.blockedSenders as string[]) : [];
		const mailboxAllowed = Array.isArray(settings.allowedSenders) ? (settings.allowedSenders as string[]) : [];
		const globalBlocked = await getGlobalBlockedSenders(env);
		const isAllowed = isSenderBlocked(senderAddress, mailboxAllowed);
		const isBlocked = !isAllowed && (isSenderBlocked(senderAddress, mailboxBlocked) || isSenderBlocked(senderAddress, globalBlocked));
		if (isBlocked) {
			targetFolder = Folders.TRASH;
			console.log(`Inbound email from ${senderAddress} is blocked for ${mailboxId}. Routed directly to Trash.`);
		}
	} catch (e) {
		console.error("Error checking blocked sender:", e);
	}

	await stub.createEmail(targetFolder, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: senderAddress, recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
		auth_code: quickMetadata.auth_code, quick_link: quickMetadata.quick_link,
	}, attachmentData);

}

export { app, receiveEmail };
