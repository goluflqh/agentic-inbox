import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractQuickEmailMetadata } from '../workers/lib/quick-email-metadata.ts';

test('does not mistake digits in a magic link for a verification code', () => {
  const result = extractQuickEmailMetadata({ subject: 'Sign in with magic link', text: 'Click https://example.com/login?token=12345678 to sign in' });
  assert.equal(result.auth_code, null);
});

test('extracts a complete labeled code without merging unrelated numbers', () => {
  assert.equal(extractQuickEmailMetadata({ subject: 'Your verification code', text: 'Code: 123456\nExpires in 10 minutes' }).auth_code, '123456');
  assert.equal(extractQuickEmailMetadata({ text: 'Your code: 1234 5678\n2026' }).auth_code, '12345678');
  assert.equal(extractQuickEmailMetadata({ text: 'Your code: 987654321' }).auth_code, null);
});

test('avoids guessing codes from reference numbers and link-only emails', () => {
  assert.equal(extractQuickEmailMetadata({ subject: 'Verification link', text: 'Click the link. Reference 123456.' }).auth_code, null);
  assert.equal(extractQuickEmailMetadata({ text: 'Code: 123456 10 minutes' }).auth_code, '123456');
  assert.equal(extractQuickEmailMetadata({ text: 'Your OTP: 1 2 3 4 5 6' }).auth_code, '123456');
  assert.equal(extractQuickEmailMetadata({ text: 'Your code expires on 2026-12-01.' }).auth_code, null);
});

test('recognizes a standalone Notion signup code without including adjacent numbers', () => {
  const html = '<h1>Sign up for Notion</h1><p>You can sign up by entering the code on the sign up page in Notion, or simply by clicking the magic link.</p><div>628279</div><a href="https://example.com/login?token=12345678">Sign in</a>';
  assert.equal(extractQuickEmailMetadata({ subject: 'Your Notion signup code', html }).auth_code, '628279');
  assert.equal(extractQuickEmailMetadata({ subject: 'Your signup code', html: '<p>Code expires on 2026-12-01</p><a href="https://example.com/login?token=123456">Sign in</a>' }).auth_code, null);
  assert.equal(extractQuickEmailMetadata({ subject: 'Your signup code', html: '<div>123456</div><div>987654</div>' }).auth_code, null);
});

test('does not surface unrelated links as verification links', () => {
  assert.equal(extractQuickEmailMetadata({ html: '<a href="https://example.com/blog">Read our blog</a>' }).quick_link, null);
  assert.equal(extractQuickEmailMetadata({ html: '<a href="https://example.com/a/opaque">Sign in to your account</a>' }).quick_link, 'https://example.com/a/opaque');
});
