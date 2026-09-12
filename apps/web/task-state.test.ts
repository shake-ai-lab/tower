import test from 'node:test';
import assert from 'node:assert/strict';
import type { Report, Session } from '@tower/shared';
import { badgeRepeatsReport, canMarkDone, isFinished, needsYou, onlyOldFailures, stateBadge, taskState } from './src/task-state.ts';
import { verifyBadge } from './src/lib.ts';

const report = (outcome: Report['outcome'], needsDecision: string | null = null): Report =>
  ({ request: 'r', outcome, summary: ['やった'], changedFiles: [], needsDecision, nextStep: null, raw: '', generatedAt: 1 });

const task = (patch: Partial<Session>) =>
  ({ status: 'idle', pending: null, report: null, verification: null, completedByUser: null, origin: 'tower', ...patch }) as unknown as Session;

test('a report that says 完了 reads as 完了 and has no 完了にする button', () => {
  const s = task({ report: report('done') });
  assert.equal(taskState(s), 'done');
  assert.equal(stateBadge(s).label, '✓ 完了');
  assert.equal(canMarkDone(s), false);
  assert.equal(isFinished(s), true);
  assert.equal(badgeRepeatsReport(s), true);
});

test('partial / failed reports keep the button so you can close them by hand', () => {
  for (const [outcome, label] of [['partial', '一部完了'], ['failed', '失敗']] as const) {
    const s = task({ report: report(outcome) });
    assert.equal(stateBadge(s).label, label);
    assert.equal(canMarkDone(s), true);
    assert.equal(isFinished(s), false);
  }
});

test('a report asking for your decision is 判断待ち, even when it says 完了', () => {
  const s = task({ report: report('done', 'どちらにしますか') });
  assert.equal(needsYou(s), true);
  assert.equal(stateBadge(s).label, '判断待ち');
  assert.equal(canMarkDone(s), true);
  assert.equal(badgeRepeatsReport(s), false);
});

test('完了 but the automatic check failed is 要確認, not 完了', () => {
  const s = task({ report: report('done'), verification: { ok: false } as Session['verification'] });
  assert.equal(stateBadge(s).label, '要確認');
  assert.equal(canMarkDone(s), true);
  assert.equal(isFinished(s), false);
  assert.equal(badgeRepeatsReport(s), false);
});

test('完了 with only the failures that were already there before the work: stays 完了, badge says 前からの失敗', () => {
  const v = (ok: boolean, failed: string[]) => ({ ok, failed }) as Session['verification'];
  const s = task({ report: report('done'), baseline: v(false, ['a']), verification: v(false, ['a']) });
  assert.equal(onlyOldFailures(s), true);
  assert.equal(stateBadge(s).label, '✓ 完了');
  assert.equal(verifyBadge(s)?.text, '△ 前からの失敗');
  // 新しく壊れたものがあれば今まで通り 要確認
  const worse = task({ report: report('done'), baseline: v(false, ['a']), verification: v(false, ['a', 'b']) });
  assert.equal(onlyOldFailures(worse), false);
  assert.equal(stateBadge(worse).label, '要確認');
  // 修正前は通っていたなら 要確認
  assert.equal(stateBadge(task({ report: report('done'), baseline: v(true, []), verification: v(false, []) })).label, '要確認');
});

test('marked done by you: 完了 badge, keeps the partial report visible, no button', () => {
  const s = task({ status: 'done', completedByUser: 5, report: report('partial') });
  assert.equal(stateBadge(s).label, '✓ 完了');
  assert.match(stateBadge(s).title ?? '', /あなたが/);
  assert.equal(canMarkDone(s), false);
  assert.equal(badgeRepeatsReport(s), false);
});

test('stopped is not finished (it can be resumed), even with a 完了 report; you can still close it by hand', () => {
  for (const s of [task({ status: 'stopped' }), task({ status: 'stopped', report: report('done') })]) {
    assert.equal(stateBadge(s).label, '停止');
    assert.equal(isFinished(s), false);
    assert.equal(canMarkDone(s), true);
  }
  assert.equal(isFinished(task({ status: 'error' })), true);
  assert.equal(isFinished(task({ status: 'done' })), true);
});

test('ended without a 完了 report is 終了; working and external-working tasks', () => {
  assert.equal(stateBadge(task({ status: 'done' })).label, '終了');
  assert.equal(stateBadge(task({ status: 'done', report: report('done') })).label, '✓ 完了');
  assert.equal(stateBadge(task({ status: 'idle' })).label, '指示待ち');
  const running = task({ status: 'running', report: report('done') });
  assert.equal(stateBadge(running).label, '作業中');
  assert.equal(isFinished(running), false);
  assert.equal(canMarkDone(running), true);
  assert.equal(canMarkDone(task({ status: 'running', origin: 'external' })), false);
});
