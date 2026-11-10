// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

function isPublicIdentityHost(hostname: string) {
	return hostname === "lequanghuy.dev" || hostname === "www.lequanghuy.dev";
}

function publicIdentityPage() {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>lequanghuy.dev</title>
	<meta name="description" content="Public identity and email policy for lequanghuy.dev." />
	<style>
		:root { color-scheme: light; }
		* { box-sizing: border-box; }
		body {
			margin: 0;
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			color: #17201b;
			background: #f7faf7;
			line-height: 1.6;
		}
		main { max-width: 920px; margin: 0 auto; padding: 64px 24px; }
		header { margin-bottom: 44px; }
		h1 { margin: 0 0 14px; font-size: clamp(40px, 8vw, 82px); line-height: 0.95; letter-spacing: 0; }
		.lede { max-width: 680px; margin: 0; font-size: 20px; color: #405047; }
		section { padding: 28px 0; border-top: 1px solid #dfe8df; }
		h2 { margin: 0 0 12px; font-size: 22px; }
		p { margin: 0 0 14px; }
		ul { margin: 0; padding-left: 22px; }
		a { color: #056b46; }
		.badge { display: inline-flex; align-items: center; min-height: 32px; padding: 4px 10px; border: 1px solid #b9d8c7; border-radius: 6px; background: #edf8f1; color: #0d5d3f; font-weight: 650; }
		.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px; }
		@media (max-width: 720px) { main { padding: 44px 18px; } .grid { grid-template-columns: 1fr; gap: 0; } }
	</style>
</head>
<body>
	<main>
		<header>
			<p class="badge">Personal domain and email identity</p>
			<h1>lequanghuy.dev</h1>
			<p class="lede">This domain is used by Huy Le for a private custom inbox and low-volume transactional or one-to-one email replies.</p>
		</header>

		<section class="grid" aria-label="Domain context">
			<div>
				<h2>About</h2>
				<p>lequanghuy.dev is a personal domain connected to a custom inbox application hosted on Cloudflare Workers.</p>
				<p>The protected inbox app is available at <a href="https://inbox.quanghuylee.cyou">https://inbox.quanghuylee.cyou</a>.</p>
			</div>
			<div>
				<h2>Email Use</h2>
				<p>Email from this domain is intended for direct replies, personal messages, testing, and app-related transactional notifications.</p>
				<p>Messages are sent manually or as a result of a clear user/app action.</p>
			</div>
		</section>

		<section class="grid" aria-label="Compliance policy">
			<div>
				<h2>Recipient Policy</h2>
				<ul>
					<li>Recipients are people who contacted this domain first, authorized users, or contacts with a clear relationship to the sender.</li>
					<li>This domain does not use purchased, scraped, public, or third-party contact lists.</li>
					<li>This domain is not used for cold outreach, bulk marketing, newsletters, or promotional campaigns.</li>
				</ul>
			</div>
			<div>
				<h2>Contact</h2>
				<p>For domain or email-deliverability questions, contact <a href="mailto:huy@lequanghuy.dev">huy@lequanghuy.dev</a>.</p>
				<p>Expected sending volume is low and primarily consists of personal replies and transactional tests.</p>
			</div>
		</section>
	</main>
</body>
</html>`;
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
	await next();
	c.header(
		"Content-Security-Policy",
		[
			"default-src 'self'",
			"base-uri 'self'",
			"object-src 'none'",
			"frame-ancestors 'none'",
			"img-src 'self' data: blob: https:",
			"style-src 'self' 'unsafe-inline'",
			"script-src 'self' 'unsafe-inline'",
			"connect-src 'self'",
			"frame-src 'self' data: blob:",
		].join("; "),
	);
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "no-referrer");
	c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
	c.header("X-Frame-Options", "DENY");
});

app.get("*", (c, next) => {
	const requestUrl = new URL(c.req.url);
	if (!isPublicIdentityHost(requestUrl.hostname)) return next();
	return c.html(publicIdentityPage());
});

// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	// Skip validation in development and local previews only.
	const requestUrl = new URL(c.req.url);
	if (import.meta.env.DEV || ["localhost", "127.0.0.1", "::1"].includes(requestUrl.hostname)) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model note: once a teammate passes the shared Cloudflare
	// Access policy, they can access all mailboxes in this app by design.
	return next();
});

// MCP server endpoint -- used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
