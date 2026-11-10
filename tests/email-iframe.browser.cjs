const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(__dirname, 'vite.iframe.config.mjs')], { cwd: root, stdio: 'ignore' });
  let browser;
  try {
    const url = 'http://127.0.0.1:5193/tests/email-iframe.html';
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Vite test server did not start');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('**/tests/email-iframe.html', async route => { const response = await route.fetch(); await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "default-src 'self'; img-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self' data: blob:" } }); });
    await context.route('https://images.example.com/logo.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN8AAAAASUVORK5CYII=', 'base64') }));
    await context.route('https://example.com/**', route => route.fulfill({ status: 200, body: 'Destination' }));
    await context.route('**/fixture-inline.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN8AAAAASUVORK5CYII=', 'base64') }));
    const page = await context.newPage();
    await page.goto(url);
    const iframe = page.frameLocator('iframe[title="Email content"]');
    await iframe.getByText('Email heading').waitFor();
    assert.equal(await iframe.getByText('Email heading').evaluate(el => getComputedStyle(el).color), 'rgb(12, 34, 56)');
    await iframe.getByAltText('inline fixture').waitFor();
    await page.waitForFunction(() => { const frame = document.querySelector('iframe'); return frame && frame.clientHeight > 0; });
    assert.equal(await iframe.getByAltText('inline fixture').evaluate(el => new Promise(resolve => { if (el.complete) resolve(el.naturalWidth > 0); else { el.onload = () => resolve(el.naturalWidth > 0); el.onerror = () => resolve(false); } })), true);
    assert.equal(await iframe.getByAltText('remote fixture').evaluate(el => new Promise(resolve => { if (el.complete) resolve(el.naturalWidth > 0); else { el.onload = () => resolve(el.naturalWidth > 0); el.onerror = () => resolve(false); } })), true);
    assert.equal(await iframe.getByText('Bad link').getAttribute('href'), null);
    const [popup] = await Promise.all([page.waitForEvent('popup'), iframe.getByText('Sign in').click()]);
    await popup.waitForLoadState();
    assert.equal(popup.url(), 'https://example.com/signin');
    assert.equal(await popup.evaluate(() => window.opener), null);
    console.log('PASS: email CSS preserved, unsafe link removed, external link opens isolated popup');
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
