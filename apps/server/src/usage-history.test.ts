import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '@tower/shared';
import { Hub } from './hub.ts';
import { Db } from './db.ts';

test('usage increments go to the ledger once, and the session does not grow a usageHistory', () => {
  const db = new Db(':memory:');
  const hub = new Hub(db);
  hub.add({ id: 'usage', status: 'stopped', createdAt: 1, updatedAt: 1, costUsd: 12, usage: { input: 100, cacheRead: 20, output: 30 } } as Session);
  hub.update('usage', { costUsd: 15, usage: { input: 180, cacheRead: 40, output: 50 } });
  hub.update('usage', { costUsd: 15, usage: { input: 180, cacheRead: 40, output: 50 } });
  hub.update('usage', { activity: 'unrelated update' });
  assert.deepEqual(db.usageSummary(Date.now()).today, { count: 1, cost: 3, input: 80, cacheRead: 20, output: 20 });
  assert.equal(hub.get('usage')!.usageHistory, undefined);
  assert.equal(new Hub(db).get('usage')!.usageHistory, undefined);
});

test('an old usageHistory is imported into the ledger, then dropped from the saved session', () => {
  const db = new Db(':memory:');
  const history = [{ ts: Date.now(), cost: 0.5, input: 50, cacheRead: 5, output: 10 }];
  db.saveSession({ id: 'old', status: 'idle', createdAt: 1, updatedAt: 1, costUsd: 0.5, usage: { input: 50, cacheRead: 5, output: 10 }, usageHistory: history } as Session);
  new Hub(db);
  assert.deepEqual(db.usageSummary(Date.now()).today, { count: 1, cost: 0.5, input: 50, cacheRead: 5, output: 10 });
  assert.equal(db.loadSessions()[0].usageHistory, undefined);
  // 2 回目の起動でも二重に積まない
  new Hub(db);
  assert.deepEqual(db.usageSummary(Date.now()).all, { count: 1, cost: 0.5, input: 50, cacheRead: 5, output: 10 });
});
