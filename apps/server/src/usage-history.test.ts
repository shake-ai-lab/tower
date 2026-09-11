import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '@tower/shared';
import { Hub } from './hub.ts';
import { Db } from './db.ts';

test('usage increments are timestamped once, preserved across restart, and exclude historical totals', () => {
  const db = new Db(':memory:');
  const hub = new Hub(db);
  hub.add({ id: 'usage', status: 'stopped', createdAt: 1, updatedAt: 1, costUsd: 12, usage: { input: 100, cacheRead: 20, output: 30 } } as Session);
  const start = Date.now();
  hub.update('usage', { costUsd: 15, usage: { input: 180, cacheRead: 40, output: 50 } });
  hub.update('usage', { costUsd: 15, usage: { input: 180, cacheRead: 40, output: 50 } });
  hub.update('usage', { activity: 'unrelated update' });
  const records = new Hub(db).get('usage')!.usageHistory!;
  assert.equal(records.length, 1);
  assert.ok(records[0].ts >= start);
  assert.deepEqual({ ...records[0], ts: 0 }, { ts: 0, cost: 3, input: 80, cacheRead: 20, output: 20 });
});
