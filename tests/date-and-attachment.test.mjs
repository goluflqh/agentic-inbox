import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDateBounds } from '../app/lib/date-range.ts';
import { validateAttachmentSizes, MAX_ATTACHMENT_BYTES } from '../shared/attachment-limits.ts';

test('date range includes both local calendar days and rejects invalid ranges', () => {
  const bounds = localDateBounds('2026-03-02', '2026-03-03');
  assert.equal(new Date(bounds.start).getHours(), 0);
  assert.equal(new Date(bounds.end).getHours(), 23);
  assert.equal(new Date(bounds.end).getMilliseconds(), 999);
  assert.equal(localDateBounds('2026-03-03', '2026-03-02'), null);
  assert.equal(localDateBounds('2026-02-30', ''), null);
});

test('attachment limits bound count and total raw bytes', () => {
  assert.equal(validateAttachmentSizes([MAX_ATTACHMENT_BYTES]), null);
  assert.ok(validateAttachmentSizes([MAX_ATTACHMENT_BYTES, 1]));
  assert.ok(validateAttachmentSizes(Array(11).fill(0)));
  assert.ok(validateAttachmentSizes([-1]));
});
