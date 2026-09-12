import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '@tower/shared';
import { Hub, ledgerRowsFor } from './hub.ts';
import { Db } from './db.ts';

const mk = (over: Partial<Session>): Session =>
  ({
    id: 'a',
    agent: 'claude',
    project: { path: 'C:/work/app', name: 'app' },
    model: null,
    status: 'stopped',
    createdAt: 1_000,
    updatedAt: 1_000,
    costUsd: 0,
    usage: { input: 0, cacheRead: 0, output: 0 },
    ...over,
  }) as Session;

test('使った量が増えると台帳に載り、同じ値の更新では増えない', () => {
  const db = new Db(':memory:');
  const hub = new Hub(db);
  hub.add(mk({ id: 'a', costUsd: 1, usage: { input: 100, cacheRead: 10, output: 20 } }));
  hub.update('a', { costUsd: 1.5, usage: { input: 180, cacheRead: 30, output: 50 } });
  let s = db.usageSummary(Date.now());
  assert.deepEqual(s.today, { count: 1, input: 80, cacheRead: 20, output: 30, cost: 0.5 });
  assert.deepEqual(s.all, s.today);
  assert.deepEqual(s.week, s.today);
  assert.equal(s.projectsToday.length, 1);
  assert.equal(s.projectsToday[0].name, 'app');
  assert.equal(s.projectsToday[0].path, 'C:/work/app');
  assert.equal(s.projectsToday[0].cost, 0.5);

  hub.update('a', { costUsd: 1.5, usage: { input: 180, cacheRead: 30, output: 50 } });
  hub.update('a', { activity: '関係ない更新' });
  s = db.usageSummary(Date.now());
  assert.deepEqual(s.today, { count: 1, input: 80, cacheRead: 20, output: 30, cost: 0.5 });
});

test('タスクを消しても使った量の合計は変わらない', () => {
  const db = new Db(':memory:');
  const hub = new Hub(db);
  hub.add(mk({ id: 'a', costUsd: 0 }));
  hub.add(mk({ id: 'b', costUsd: 0, project: { path: 'C:/work/other', name: 'other' } }));
  hub.update('a', { costUsd: 0.2, usage: { input: 50, cacheRead: 0, output: 10 } });
  hub.update('b', { costUsd: 0.3, usage: { input: 70, cacheRead: 5, output: 15 } });
  const before = db.usageSummary(Date.now());
  assert.equal(before.today.count, 2);
  assert.equal(before.today.cost, 0.5);

  hub.remove('a');
  assert.equal(hub.get('a'), undefined);
  const after = db.usageSummary(Date.now());
  assert.deepEqual(after, before);
  assert.equal(after.projectsToday.length, 2);
});

test('外部セッションの更新は台帳に積まない', () => {
  const db = new Db(':memory:');
  const hub = new Hub(db);
  hub.add(mk({ id: 'x', origin: 'external', costUsd: 0 }));
  hub.update('x', { costUsd: 3, usage: { input: 10, cacheRead: 0, output: 10 } });
  assert.deepEqual(db.usageSummary(Date.now()).all, { count: 0, input: 0, cacheRead: 0, output: 0, cost: 0 });
});

test('ledgerRowsFor: usageHistory の各項目と、日付が分からない残りを行にする', () => {
  const history = [
    { ts: 10, cost: 0.1, input: 10, cacheRead: 1, output: 2 },
    { ts: 20, cost: 0.2, input: 20, cacheRead: 2, output: 4 },
  ];
  // 残りあり → 3 行（残りは dated 0、ts は createdAt）
  const withRest = ledgerRowsFor(mk({ id: 's', createdAt: 5, costUsd: 1, usage: { input: 100, cacheRead: 3, output: 6 }, usageHistory: history }));
  assert.equal(withRest.length, 3);
  assert.deepEqual(withRest[0], { session_id: 's', project_path: 'C:/work/app', project_name: 'app', agent: 'claude', model: null, ts: 10, cost: 0.1, input: 10, cache_read: 1, output: 2, dated: 1 });
  assert.equal(withRest[1].dated, 1);
  assert.deepEqual({ ...withRest[2], cost: Math.round(withRest[2].cost * 1000) / 1000 }, { session_id: 's', project_path: 'C:/work/app', project_name: 'app', agent: 'claude', model: null, ts: 5, cost: 0.7, input: 70, cache_read: 0, output: 0, dated: 0 });

  // 残り無し → 2 行
  const exact = ledgerRowsFor(mk({ id: 's', costUsd: 0.3, usage: { input: 30, cacheRead: 3, output: 6 }, usageHistory: history }));
  assert.equal(exact.length, 2);
  assert.ok(exact.every((r) => r.dated === 1));

  // 合計が履歴より小さい（負になる）分は 0 扱いで、行を足さない
  const under = ledgerRowsFor(mk({ id: 's', costUsd: 0.1, usage: { input: 5, cacheRead: 0, output: 0 }, usageHistory: history }));
  assert.equal(under.length, 2);

  // 外部 → 0 行
  assert.deepEqual(ledgerRowsFor(mk({ id: 'x', origin: 'external', costUsd: 5, usage: { input: 1, cacheRead: 0, output: 1 }, usageHistory: history })), []);
});

test('起動時の取り込みは 1 回だけ（2 回目の Hub で増えない）', () => {
  const db = new Db(':memory:');
  db.saveSession(mk({ id: 'old', createdAt: 1, costUsd: 2, usage: { input: 200, cacheRead: 20, output: 40 }, usageHistory: [{ ts: Date.now(), cost: 0.5, input: 50, cacheRead: 5, output: 10 }] }));
  db.saveSession(mk({ id: 'ext', origin: 'external', costUsd: 9, usage: { input: 9, cacheRead: 0, output: 9 } }));

  new Hub(db);
  const first = db.usageSummary(Date.now());
  assert.deepEqual(first.all, { count: 1, input: 200, cacheRead: 20, output: 40, cost: 2 });
  assert.deepEqual(first.today, { count: 1, input: 50, cacheRead: 5, output: 10, cost: 0.5 });
  assert.equal(db.getMeta('usage_imported'), '1');

  new Hub(db);
  assert.deepEqual(db.usageSummary(Date.now()), first);
});
