const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(__dirname, 'vite.iframe.config.mjs')], { cwd: root, stdio: 'inherit' });
  let browser;
  try {
    const url = 'http://127.0.0.1:5193/tests/inbox-fixture.html';
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'test server did not start');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', error => console.error('Browser error:', error.message));
    page.on('console', message => { if (message.type() === 'error') console.error('Console:', message.text()); });
    await page.goto(url);
    await page.getByText('Fixture unread message').first().waitFor();
    assert.match(await page.evaluate(() => window.testRouter.state.location.search), /page=3/);
    await page.getByText('Fixture unread message').first().click();
    await page.frameLocator('iframe[title="Email content"]').getByText('Fixture message body').waitFor();
    await page.getByText('No emails in all inbox').waitFor();
    await page.frameLocator('iframe[title="Email content"]').getByText('Fixture message body').waitFor();
    assert.match(await page.evaluate(() => window.testRouter.state.location.search), /page=3/);
    await page.getByLabel('From date').fill('2026-01-01');
    assert.match(await page.evaluate(() => window.testRouter.state.location.search), /from_date=2026-01-01/);
    assert.doesNotMatch(await page.evaluate(() => window.testRouter.state.location.search), /page=3/);
    await page.waitForFunction(() => window.fixtureQueries.some(q => new URLSearchParams(q).has('date_start')));
    console.log('PASS: unread panel survives refetch; page 3 retained; date filter resets pagination and reaches API');
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
