import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session, TimelineItem } from '@tower/shared';
import { Db } from './db.ts';
import { Hub } from './hub.ts';

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 'instruction-history', agent: 'codex', agentSessionId: 'thread',
    project: { path: 'C:/unused', name: 'unused' }, title: 'test', prompt: 'test',
    model: null, permissionMode: 'acceptEdits', status: 'idle', activity: '報告あり',
    pending: null, report: null, turns: 1, costUsd: 0, toolCalls: 0, changedFiles: [],
    createdAt: 1, updatedAt: 20, lastError: null, ...patch,
  };
}

function item(ts: number, kind: TimelineItem['kind'] = 'user'): TimelineItem {
  return { id: `${kind}-${ts}`, sessionId: 'instruction-history', ts, kind, text: 'test' };
}

test('user instructions remain newer than an old report after resume, stop, error, and restart', () => {
  for (const status of ['stopped', 'error'] as const) {
    const db = new Db(':memory:');
    const hub = new Hub(db);
    const report = { outcome: 'done' as const, request: 'test', summary: ['test'], changedFiles: [], needsDecision: null, nextStep: null, raw: 'test', generatedAt: 100 };
    hub.add(session({ report }));
    hub.timeline(item(200));
    hub.update('instruction-history', { status: 'running' });
    hub.update('instruction-history', { status });
    const restored = new Hub(db).get('instruction-history')!;
    assert.equal(restored.status, status);
    assert.equal(restored.lastInstructionAt, 200);
    assert.equal(restored.report?.generatedAt, 100);
  }
});

test('non-user events and delayed older instructions do not advance or reverse the instruction timestamp', () => {
  const db = new Db(':memory:');
  const hub = new Hub(db);
  hub.add(session());
  const seen: number[] = [];
  hub.subscribe(ev => { if (ev.type === 'session') seen.push(ev.session.lastInstructionAt!); });
  hub.timeline(item(200));
  hub.timeline(item(500, 'assistant_text'));
  hub.timeline(item(100));
  assert.equal(hub.get('instruction-history')?.lastInstructionAt, 200);
  assert.deepEqual(seen, [200]);
  assert.equal(db.loadSessions()[0].lastInstructionAt, 200);
});

test('legacy sessions restore the newest user event even with over 500 newer timeline events', () => {
  const db = new Db(':memory:');
  db.saveSession(session());
  db.appendTimeline(item(10));
  db.appendTimeline(item(15));
  for (let ts = 30; ts < 640; ts++) db.appendTimeline(item(ts, 'tool_use'));
  // 件数の外に押し出された指示は、最後の 1 件だけ先頭に足される（それより古い指示は足さない）
  const loaded = db.loadTimeline('instruction-history');
  assert.deepEqual(loaded.filter(event => event.kind === 'user').map(event => event.ts), [15]);
  assert.equal(loaded[0].ts, 15);
  const restored = new Hub(db).get('instruction-history')!;
  assert.equal(restored.lastInstructionAt, 15);
  assert.equal(restored.updatedAt, 20);
  assert.equal(db.loadSessions()[0].lastInstructionAt, 15);
});

test('legacy sessions without user history stay unknown and saved timestamps are preserved', () => {
  const db = new Db(':memory:');
  db.saveSession(session());
  assert.equal(new Hub(db).get('instruction-history')?.lastInstructionAt, undefined);
  db.saveSession(session({ lastInstructionAt: 500 }));
  db.appendTimeline(item(100));
  const restored = new Hub(db).get('instruction-history')!;
  assert.equal(restored.lastInstructionAt, 500);
  assert.equal(restored.updatedAt, 20);
});
