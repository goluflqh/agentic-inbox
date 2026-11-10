const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..');
  const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(__dirname, 'vite.iframe.config.mjs')], { cwd: root, stdio: 'ignore' });
  let browser;
  try {
    const url = 'http://127.0.0.1:5193/tests/compose-fixture.html';
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'test server did not start');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('Browser error:', error.message));
    await page.goto(url);
    await page.getByLabel('Attach files').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('test attachment') });
    await page.getByText('note.txt').waitFor();
    await page.getByRole('button', { name: 'Save as Draft' }).click();
    await page.getByText('Attachments cannot yet be saved in drafts.', { exact: false }).first().waitFor();
    await page.getByPlaceholder('recipient@example.com').fill('receiver@example.com');
    await page.getByPlaceholder('Email subject').fill('Fixture attachment');
    await page.locator('.ProseMirror').fill('Fixture body');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => window.fixtureRequests.some(r => r.path.endsWith('/emails') && r.method === 'POST'));
    const sent = await page.evaluate(() => JSON.parse(window.fixtureRequests.find(r => r.path.endsWith('/emails') && r.method === 'POST').body));
    assert.equal(sent.attachments[0].filename, 'note.txt');
    assert.equal(Buffer.from(sent.attachments[0].content, 'base64').toString(), 'test attachment');
    await page.goto(url + '?warning=1');
    await page.getByPlaceholder('recipient@example.com').fill('receiver@example.com');
    await page.getByPlaceholder('Email subject').fill('Warning case');
    await page.locator('.ProseMirror').fill('Fixture body');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('The provider accepted this email, but the Sent copy could not be saved.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    console.log('PASS: attachment payload, draft guard and accepted-but-unsaved warning (mocked provider)');
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
