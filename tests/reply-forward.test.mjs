import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const entry = new URL('../workers/routes/reply-forward.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const built = await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'mock-delivery', setup(build) {
  build.onResolve({ filter: /^\.\.\/email-sender$/ }, () => ({ path: 'sender', namespace: 'fixture' }));
  build.onResolve({ filter: /^\.\.\/lib\/attachments$/ }, () => ({ path: 'storage', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'sender' ? 'export const sendEmail = (...args) => globalThis.__testSend(...args);' : 'export const storeAttachments = async () => { globalThis.__testEvents.push("store"); return []; };', loader: 'js' }));
} }] });
const module = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);

for (const name of ['handleReplyEmail', 'handleForwardEmail']) {
  test(`${name} reports provider failure without creating a sent record`, async () => {
    const events = globalThis.__testEvents = [];
    globalThis.__testSend = async () => { events.push('send'); throw new Error('provider unavailable'); };
    const stub = { getEmail: async () => ({ id: 'original', sender: 'other@example.com', folder_id: 'inbox' }), checkSendRateLimit: async () => null, createEmail: async () => events.push('create'), markThreadRead: async () => events.push('read') };
    const ctx = { req: { param: key => key === 'mailboxId' ? 'sender@example.com' : 'original', json: async () => ({ to: 'other@example.com', from: 'sender@example.com', subject: 'Hello', text: 'Body', attachments: [{ filename: 'a.txt', content: 'YQ==', type: 'text/plain', disposition: 'attachment' }] }) }, var: { mailboxStub: stub }, env: { BUCKET: {} }, json: (body, status) => ({ body, status }) };
    const result = await module.exports[name](ctx);
    assert.equal(result.status, 502);
    assert.deepEqual(events, ['send']);
    globalThis.__testSend = async (_env, message) => { events.push('send-success'); assert.equal(message.attachments[0].content, 'YQ=='); };
    const success = await module.exports[name](ctx);
    assert.equal(success.status, 202);
    assert.deepEqual(events.slice(1, 4), ['send-success', 'store', 'create']);
    stub.createEmail = async () => { throw new Error('database unavailable'); };
    const incomplete = await module.exports[name](ctx);
    assert.equal(incomplete.status, 202);
    assert.equal(incomplete.body.status, 'sent_save_failed');
  });
}
