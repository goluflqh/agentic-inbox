import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPrefix } from '../workers/lib/aggregate-page.ts';

test('fetches beyond the per-query 100 row cap with stable page size', async () => {
  const rows = Array.from({ length: 230 }, (_, i) => i);
  const calls = [];
  const result = await fetchPrefix(175, async (page, limit) => {
    calls.push([page, limit]);
    return rows.slice((page - 1) * limit, page * limit);
  });
  assert.deepEqual(result, rows.slice(0, 175));
  assert.deepEqual(calls, [[1, 100], [2, 100]]);
});

test('stops on the last partial page', async () => {
  const calls = [];
  const result = await fetchPrefix(300, async (page, limit) => {
    calls.push(page);
    return page === 1 ? Array.from({length: limit}, (_, i) => i) : [100];
  });
  assert.equal(result.length, 101);
  assert.deepEqual(calls, [1, 2]);
});
