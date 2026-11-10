import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const built = await esbuild.build({ entryPoints: [new URL('../workers/lib/schemas.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, require);
const { SendEmailRequestSchema } = module.exports;
const base = { to: 'recipient@example.com', from: 'sender@example.com', subject: 'test', text: 'body' };
const file = content => ({ filename: 'test.txt', type: 'text/plain', disposition: 'attachment', content });

test('send schema rejects invalid base64, excessive count and aggregate size', () => {
  assert.equal(SendEmailRequestSchema.safeParse({ ...base, attachments: [file('aGVsbG8=')] }).success, true);
  assert.equal(SendEmailRequestSchema.safeParse({ ...base, attachments: [file('bad!')] }).success, false);
  assert.equal(SendEmailRequestSchema.safeParse({ ...base, attachments: Array(11).fill(file('')) }).success, false);
  const large = Buffer.alloc(3 * 1024 * 1024).toString('base64');
  assert.equal(SendEmailRequestSchema.safeParse({ ...base, attachments: [file(large), file(large)] }).success, false);
});
