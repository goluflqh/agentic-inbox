import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const entry = new URL("../workers/index.ts", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const built = await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: "node",
	format: "cjs",
	write: false,
	external: ["cloudflare:workers"],
});

const module = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(module, module.exports, require);
const { resolveInboundMailboxId } = module.exports;

const baseEnv = {
	DOMAINS: "quanghuylee.cyou,routerllm.bond,lequanghuy.dev",
	EMAIL_ADDRESSES: [],
};

test("routes Gmail auto-forwarded email using Cloudflare envelope event.to", () => {
	const result = resolveInboundMailboxId(baseEnv, "gmail@routerllm.bond", ["cortis@gmail.com"]);
	assert.deepEqual(result, { mailboxId: "gmail@routerllm.bond" });
});

test("routes BCC or empty MIME To email using envelope event.to", () => {
	const result = resolveInboundMailboxId(baseEnv, "bcc@quanghuylee.cyou", []);
	assert.deepEqual(result, { mailboxId: "bcc@quanghuylee.cyou" });
});

test("normalizes bracketed and uppercase envelope addresses", () => {
	const result = resolveInboundMailboxId(baseEnv, " <Gmail@RouterLLM.BOND> ", ["other@gmail.com"]);
	assert.deepEqual(result, { mailboxId: "gmail@routerllm.bond" });
});

test("routes direct inbound email and falls back to configured MIME recipient if event.to is absent", () => {
	assert.deepEqual(
		resolveInboundMailboxId(baseEnv, "hello@routerllm.bond", ["hello@routerllm.bond"]),
		{ mailboxId: "hello@routerllm.bond" },
	);
	assert.deepEqual(
		resolveInboundMailboxId(baseEnv, undefined, ["cortis@gmail.com", "inbox@lequanghuy.dev"]),
		{ mailboxId: "inbox@lequanghuy.dev" },
	);
});

test("respects EMAIL_ADDRESSES allowlist priority and ignores unconfigured external domains", () => {
	const allowlistedEnv = {
		...baseEnv,
		EMAIL_ADDRESSES: ["gmail@routerllm.bond"],
	};
	assert.deepEqual(
		resolveInboundMailboxId(allowlistedEnv, "gmail@routerllm.bond", ["cortis@gmail.com"]),
		{ mailboxId: "gmail@routerllm.bond" },
	);

	const ignoredAllowlist = resolveInboundMailboxId(allowlistedEnv, "other@routerllm.bond", ["cortis@gmail.com"]);
	assert.equal("ignored" in ignoredAllowlist && ignoredAllowlist.ignored, true);

	const ignoredExternal = resolveInboundMailboxId(baseEnv, undefined, ["cortis@gmail.com"]);
	assert.equal("ignored" in ignoredExternal && ignoredExternal.ignored, true);

	assert.deepEqual(resolveInboundMailboxId(baseEnv, undefined, []), {
		error: "received email with empty to",
	});
});
