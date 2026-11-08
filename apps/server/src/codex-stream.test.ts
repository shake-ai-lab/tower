import test from 'node:test';
import assert from 'node:assert/strict';
import type { LiveOutput, Session, TimelineItem } from '@tower/shared';
import { CodexLiveOutput, LIVE_OUTPUT_INTERVAL_MS, LIVE_OUTPUT_MAX_CHARS, LIVE_OUTPUT_MAX_ITEMS } from './agents/codex-stream.ts';
import { CodexRunner } from './agents/codex.ts';
import type { Hub } from './hub.ts';

test('deltaを200msにまとめ、複数の項目を分けて末尾の上限まで表示する', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events: (LiveOutput[] | null)[] = [];
  const stream = new CodexLiveOutput((items) => events.push(items));
  stream.start('turn');
  stream.append('turn', 'message', 'assistant_text', '調べて');
  stream.append('turn', 'message', 'assistant_text', 'います');
  stream.append('turn', 'command', 'command_output', 'x'.repeat(LIVE_OUTPUT_MAX_CHARS) + 'latest');
  t.mock.timers.tick(LIVE_OUTPUT_INTERVAL_MS - 1);
  assert.equal(events.length, 0);
  t.mock.timers.tick(1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.[0]?.text, '調べています');
  assert.equal(events[0]?.[1]?.text.length, LIVE_OUTPUT_MAX_CHARS);
  assert.ok(events[0]?.[1]?.text.endsWith('latest'));
  assert.equal(events[0]?.[1]?.truncated, true);
  for (let i = 0; i < 20; i++) stream.append('turn', `extra-${i}`, 'command_output', `${i}`);
  t.mock.timers.tick(LIVE_OUTPUT_INTERVAL_MS);
  assert.equal(events.at(-1)?.length, LIVE_OUTPUT_MAX_ITEMS);
  stream.clear();
});

test('完了した項目の遅いdeltaを無視し、残りの項目は表示し続ける', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events: (LiveOutput[] | null)[] = [];
  const stream = new CodexLiveOutput((items) => events.push(items));
  stream.start('turn');
  stream.append('turn', 'a', 'assistant_text', 'first');
  stream.append('turn', 'b', 'command_output', 'test');
  stream.complete('a');
  assert.deepEqual(events.at(-1)?.map((item) => item.itemId), ['b']);
  stream.append('turn', 'a', 'assistant_text', 'late');
  stream.complete('b');
  const count = events.length;
  t.mock.timers.tick(1000);
  assert.equal(events.length, count);
  assert.equal(events.at(-1), null);
});

test('手番の終了・切替後に古いタイマーやdeltaで出力が復活しない', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events: (LiveOutput[] | null)[] = [];
  const stream = new CodexLiveOutput((items) => events.push(items));
  stream.start('old');
  stream.append('old', 'a', 'assistant_text', 'old');
  stream.clear();
  stream.append('old', 'a', 'assistant_text', 'late');
  t.mock.timers.tick(1000);
  assert.equal(events.length, 1);
  assert.equal(events.at(-1), null);
  stream.start('new');
  stream.append('old', 'a', 'assistant_text', 'late');
  stream.append('new', 'b', 'assistant_text', 'new');
  stream.start('new'); // turn/start応答が通知より遅れても、途中出力を消さない
  t.mock.timers.tick(LIVE_OUTPUT_INTERVAL_MS);
  assert.equal(events.at(-1)?.[0]?.text, 'new');
  stream.clear();
});

function fixture() {
  let session: Session = {
    id: 'stream', agent: 'codex', agentSessionId: 'thread', project: { path: process.cwd(), name: 'test' },
    title: 'test', prompt: 'test', model: null, permissionMode: 'default', status: 'running', activity: '',
    pending: null, report: null, turns: 0, costUsd: 0, toolCalls: 0, changedFiles: [], createdAt: 1, updatedAt: 1, lastError: null,
  };
  const timeline: TimelineItem[] = [];
  const updates: Partial<Session>[] = [];
  const hub = {
    get: () => session,
    update: (_id: string, patch: Partial<Session>) => { updates.push(patch); session = { ...session, ...patch }; return session; },
    timeline: (item: TimelineItem) => timeline.push(item),
  } as unknown as Hub;
  const runner = new CodexRunner(session, hub);
  const internal = runner as unknown as {
    threadId: string; onNotification(method: string, params: Record<string, unknown>): void;
    fail(error: Error): void; onExit(code: number): void;
  };
  internal.threadId = 'thread';
  const notify = (method: string, params: Record<string, unknown> = {}) => internal.onNotification(method, { threadId: 'thread', turnId: 'turn', ...params });
  notify('turn/started', { turn: { id: 'turn' } });
  return { runner, internal, notify, timeline, updates, session: () => session };
}

test('Runnerは本文/コマンドdeltaを配信し、確定した経過を重複させない', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.notify('item/agentMessage/delta', { itemId: 'message', delta: '回答' });
  f.notify('item/commandExecution/outputDelta', { itemId: 'command', delta: 'test running' });
  f.notify('item/agentMessage/delta', { threadId: 'child', itemId: 'child', delta: 'not parent' });
  t.mock.timers.tick(LIVE_OUTPUT_INTERVAL_MS);
  assert.deepEqual(f.session().liveOutput?.map((item) => item.text), ['回答', 'test running']);
  assert.equal(f.timeline.length, 0);
  f.notify('item/completed', { item: { id: 'message', type: 'agentMessage', text: '回答完了' } });
  assert.equal(f.timeline.length, 1);
  assert.equal(f.timeline[0]?.detail, '回答完了');
  assert.deepEqual(f.session().liveOutput?.map((item) => item.itemId), ['command']);
  f.notify('item/agentMessage/delta', { itemId: 'message', delta: 'late' });
  f.notify('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'test', status: 'completed', exitCode: 0, aggregatedOutput: 'passed' } });
  assert.equal(f.timeline.length, 2);
  assert.equal(f.session().liveOutput, null);
  t.mock.timers.tick(1000);
  assert.equal(f.session().liveOutput, null);
  f.notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } });
});

for (const ending of ['interrupt', 'failed-turn', 'stop', 'fail', 'exit'] as const) {
  test(`Runnerの${ending}後は未配信の出力と遅い通知が復活しない`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    f.notify('item/agentMessage/delta', { itemId: 'message', delta: 'partial' });
    if (ending === 'stop') await f.runner.stop();
    else if (ending === 'fail') f.internal.fail(new Error('connection failed'));
    else if (ending === 'exit') f.internal.onExit(1);
    else f.notify('turn/completed', { turn: { id: 'turn', status: ending === 'interrupt' ? 'interrupted' : 'failed' } });
    const count = f.updates.length;
    f.notify('item/agentMessage/delta', { itemId: 'late', delta: 'late' });
    f.notify('item/completed', { item: { id: 'message', type: 'agentMessage', text: 'late final' } });
    f.notify('turn/started', { turn: { id: 'turn' } });
    t.mock.timers.tick(1000);
    assert.equal(f.updates.length, count);
    assert.equal(f.session().liveOutput, null);
    assert.ok(!f.timeline.some((item) => item.detail === 'late final'));
  });
}
