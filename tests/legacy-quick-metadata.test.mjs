import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metadataFromStoredEmail } from '../workers/lib/quick-email-metadata.ts';

test('recomputes legacy false positives without changing stored messages', () => {
  const row = { subject: 'Sign in with magic link', body: '<a href="https://example.com/login?token=12345678">Sign in</a>', auth_code: '12345678', quick_link: 'https://example.com/blog' };
  const result = metadataFromStoredEmail(row.subject, row.body);
  assert.equal(result.auth_code, null);
  assert.equal(result.quick_link, 'https://example.com/login?token=12345678');
  assert.equal(row.auth_code, '12345678');
});

test('extracts codes from old plain and HTML message bodies', () => {
  assert.equal(metadataFromStoredEmail('OTP', 'Your code: 765432').auth_code, '765432');
  assert.equal(metadataFromStoredEmail('OTP', '<p>Your code: <b>123456</b></p>').auth_code, '123456');
});

test('does not return a URL truncated by the extraction limit', () => {
  const body = ' '.repeat(39970) + 'https://example.com/signin/' + 'x'.repeat(100);
  assert.equal(metadataFromStoredEmail('Login', body).quick_link, null);
});
