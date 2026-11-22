import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const entry = new URL('../workers/email-sender.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const built = await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false,
});

const module = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
const { sendEmail } = module.exports;

test('routes resend and resend2 domains to separate Resend API keys', async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, auth: init?.headers?.Authorization });
		return new Response(JSON.stringify({ id: 'msg_123' }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	try {
		const env = {
			DEFAULT_OUTBOUND_PROVIDER: 'resend',
			OUTBOUND_PROVIDER_BY_DOMAIN: 'quanghuylee.cyou:resend,routerllm.bond:resend2',
			RESEND_API_KEY: 're_key_1',
			RESEND_API_KEY_2: 're_key_2',
		};

		await sendEmail(env, {
			from: 'cortis@quanghuylee.cyou',
			to: 'user@example.com',
			subject: 'Account 1',
			text: 'Body 1',
		});
		await sendEmail(env, {
			from: 'hello@routerllm.bond',
			to: 'user@example.com',
			subject: 'Account 2',
			text: 'Body 2',
		});

		assert.equal(calls.length, 2);
		assert.equal(calls[0].auth, 'Bearer re_key_1');
		assert.equal(calls[1].auth, 'Bearer re_key_2');

		await assert.rejects(
			() => sendEmail(
				{
					DEFAULT_OUTBOUND_PROVIDER: 'resend',
					OUTBOUND_PROVIDER_BY_DOMAIN: 'routerllm.bond:resend2',
					RESEND_API_KEY: 're_key_1',
				},
				{
					from: 'hello@routerllm.bond',
					to: 'user@example.com',
					subject: 'Missing key 2',
					text: 'Body',
				},
			),
			/RESEND_API_KEY_2/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
