import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchMatch } from '../workers/lib/search-match.ts';

test('identifies subject and body and shows a later body match', () => {
  const result = searchMatch('Hello KEY', '<p>' + 'x'.repeat(500) + ' key end</p>', 'a@example.com', 'b@example.com', 'key');
  assert.deepEqual(result.fields, ['Subject', 'Body']);
  assert.match(result.excerpt, /key end/);
  assert.doesNotMatch(result.excerpt, /<p>/);
});
test('labels hidden markup separately from visible body', () => {
  assert.deepEqual(searchMatch('', '<style>.secret{}</style><p>hello</p>', '', '', 'secret').fields, ['Hidden HTML / link']);
});
