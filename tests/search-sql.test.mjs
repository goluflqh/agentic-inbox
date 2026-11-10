import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const entry = new URL('../workers/durableObject/index.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const built = await require('esbuild').build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'cloudflare-fixture', setup(build) { build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'fixture' })); build.onResolve({ filter: /^drizzle-orm\/durable-sqlite$/ }, () => ({ path: 'drizzle', namespace: 'fixture' })); build.onResolve({ filter: /^\.\/migrations$/ }, () => ({ path: 'migrations', namespace: 'fixture' })); build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'workers' ? 'export class DurableObject { constructor(ctx) { this.ctx = ctx } }' : path === 'drizzle' ? 'export const drizzle = () => ({})' : 'export const applyMigrations = () => {}; export const mailboxMigrations = []', loader: 'js' })); } }] });
const module = { exports: {} }; new Function('module','exports','require',built.outputFiles[0].text)(module,module.exports,require);
test('search includes visible, split-markup and hidden URL matches with accurate counts', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE folders (id TEXT, name TEXT); CREATE TABLE emails (id TEXT, subject TEXT, body TEXT, sender TEXT, recipient TEXT, cc TEXT, bcc TEXT, date TEXT, read INTEGER, starred INTEGER, in_reply_to TEXT, email_references TEXT, thread_id TEXT, folder_id TEXT, auth_code TEXT, quick_link TEXT, raw_headers TEXT);');
    const insert = db.prepare('INSERT INTO emails (id, subject, body, sender, recipient, date) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('hidden', 'Notion', '<a href="https://x/startup">Sign in</a>', 'n@example.com', 'a@example.com', '2026-01-02');
    insert.run('visible', 'Welcome', '<p>Startup program</p>', 'n@example.com', 'a@example.com', '2026-01-01');
    insert.run('percent', '100% useful', '<p>other</p>', 'n@example.com', 'a@example.com', '2026-01-03');
    insert.run('split', 'Other', '<p>start<strong>up</strong> program</p>', 'n@example.com', 'a@example.com', '2026-01-04');
    insert.run('encoded', 'Other', '<p>start&#117;p program</p>', 'n@example.com', 'a@example.com', '2026-01-05');
    const instance = new module.exports.MailboxDO({ storage: { sql: { exec: (sql, ...params) => db.prepare(sql).all(...params) } } }, {});
    const rows = await instance.searchEmails({ query: 'startup' });
    assert.deepEqual(rows.map(r => r.id), ['encoded', 'split', 'hidden', 'visible']);
    assert.deepEqual(rows.find(r => r.id === 'hidden').match_fields, ['Hidden HTML / link']);
    assert.deepEqual(rows.find(r => r.id === 'split').match_fields, ['Body']);
    assert.equal(await instance.countSearchResults({ query: 'startup' }), 4);
    assert.deepEqual((await instance.searchEmails({ query: '100%' })).map(r => r.id), ['percent']);
  } finally { db.close(); }
});
