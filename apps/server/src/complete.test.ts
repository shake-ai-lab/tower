import test from 'node:test';
import assert from 'node:assert/strict';
import type { Report, Session } from '@tower/shared';
import type { AgentRunner } from './agents/types.ts';
import { Db } from './db.ts';
import { Hub } from './hub.ts';
import { SessionManager } from './manager.ts';

function session(patch: Partial<Session>): Session {
  return {
    id: 'id',
    agent: 'claude',
    agentSessionId: 'agent-1',
    project: { path: 'C:\\proj', name: 'proj' },
    title: 't',
    prompt: 'p',
    model: null,
    permissionMode: 'acceptEdits',
    status: 'idle',
    activity: '報告しました',
    pending: null,
    pendingCount: 0,
    report: null,
    turns: 0,
    costUsd: 0,
    toolCalls: 0,
    changedFiles: [],
    createdAt: 1,
    updatedAt: 1,
    lastError: null,
    ...patch,
  };
}

const partial: Report = { request: 'r', outcome: 'partial', summary: ['半分できた'], changedFiles: [], needsDecision: '残りをどうしますか', nextStep: null, raw: '', generatedAt: 5 };

function setup() {
  const hub = new Hub(new Db(':memory:'));
  const manager = new SessionManager(hub);
  const timeline: string[] = [];
  hub.subscribe((ev) => { if (ev.type === 'timeline') timeline.push(ev.item.text); });
  return { hub, manager, timeline };
}

/** 動いているエージェントの代わり。stop / send が呼ばれたかだけ覚える */
function fakeRunner(hub: Hub, id: string) {
  const calls: string[] = [];
  const runner = {
    start() {},
    send(text: string) { calls.push(`send:${text}`); },
    async stop() { calls.push('stop'); hub.update(id, { status: 'stopped', activity: '停止しました' }); },
    resolvePermission: () => false,
    answerQuestion: () => false,
  } as unknown as AgentRunner;
  return { runner, calls };
}

const runnersOf = (m: SessionManager) => (m as unknown as { runners: Map<string, AgentRunner> }).runners;

test('complete turns a partly done report into done and takes it off the decision list', async () => {
  const { hub, manager, timeline } = setup();
  hub.add(session({ id: 'a', report: partial, interrupted: { at: 1, status: 'running' } }));
  const r = await manager.complete('a');
  assert.equal(r.status, 'done');
  assert.ok(r.completedByUser && r.completedByUser > 0);
  assert.equal(r.pending, null);
  assert.equal(r.interrupted, null);
  assert.equal(r.report?.outcome, 'partial'); // 報告はそのまま残す
  assert.equal(hub.get('a')!.status, 'done');
  assert.ok(timeline.some((t) => t.includes('「完了」にしました') && t.includes('一部完了')));
  // もう一度押しても同じ（年表を増やさない）
  const again = await manager.complete('a');
  assert.equal(again.completedByUser, r.completedByUser);
  assert.equal(timeline.filter((t) => t.includes('「完了」にしました')).length, 1);
});

test('complete stops a running agent first, then marks it done', async () => {
  const { hub, manager } = setup();
  hub.add(session({ id: 'b', status: 'waiting_permission', pendingCount: 1 }));
  const { runner, calls } = fakeRunner(hub, 'b');
  runnersOf(manager).set('b', runner);
  const r = await manager.complete('b');
  assert.deepEqual(calls, ['stop']);
  assert.equal(manager.runner('b'), undefined);
  assert.equal(r.status, 'done');
  assert.equal(r.pendingCount, 0);
});

test('complete refuses an external session that is still working, and unknown ids', async () => {
  const { hub, manager } = setup();
  hub.add(session({ id: 'x', origin: 'external', externalHint: 'VS Code', status: 'running' }));
  await assert.rejects(manager.complete('x'), /VS Code で作業中/);
  assert.equal(hub.get('x')!.status, 'running');
  hub.add(session({ id: 'y', origin: 'external', status: 'idle' }));
  assert.equal((await manager.complete('y')).status, 'done');
  await assert.rejects(manager.complete('nope'), /見つかりません/);
});

test('sending a new instruction clears the completed mark', () => {
  const { hub, manager } = setup();
  hub.add(session({ id: 'c', status: 'running', completedByUser: 123 }));
  const { runner, calls } = fakeRunner(hub, 'c');
  runnersOf(manager).set('c', runner);
  manager.send('c', 'つづきをお願い');
  assert.deepEqual(calls, ['send:つづきをお願い']);
  assert.equal(hub.get('c')!.completedByUser, null);
});
