import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session, TimelineItem } from '@tower/shared';
import { Db } from './db.ts';
import { Hub } from './hub.ts';
import { SessionManager } from './manager.ts';
import { ClaudeRunner } from './agents/claude.ts';
import { CodexRunner } from './agents/codex.ts';

const session = (): Session => ({ id: 'lifecycle', agent: 'claude', agentSessionId: 'thread', project: { name: 'fixture', path: process.cwd() }, title: 'test', prompt: 'test', model: null, permissionMode: 'acceptEdits', status: 'idle', activity: '', pending: null, report: null, turns: 0, costUsd: 0, toolCalls: 0, changedFiles: [], createdAt: 1, updatedAt: 1, lastError: null });

test('manual completion aborts manager checks even without a runner', async () => {
  const hub = new Hub(new Db(':memory:'));
  hub.add(session());
  const manager = new SessionManager(hub);
  const internal = manager as unknown as { trackVerification(id: string): AbortController };
  const first = internal.trackVerification('lifecycle'), second = internal.trackVerification('lifecycle');
  await manager.complete('lifecycle');
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(hub.get('lifecycle')?.status, 'done');
});

test('Codex mode changes validate agent/value and persist explicit plan-to-default transitions', () => {
  const hub = new Hub(new Db(':memory:'));
  hub.add({ ...session(), agent: 'codex' });
  const manager = new SessionManager(hub);
  assert.throws(() => manager.setCodexCollaborationMode('lifecycle', 'unknown'), /不正/);
  assert.equal(manager.setCodexCollaborationMode('lifecycle', 'default').codexCollaborationMode, undefined);
  assert.equal(manager.setCodexCollaborationMode('lifecycle', 'plan').codexCollaborationMode, 'plan');
  assert.equal(manager.setCodexCollaborationMode('lifecycle', 'default').codexCollaborationMode, 'default');
  hub.update('lifecycle', { agent: 'claude' });
  assert.throws(() => manager.setCodexCollaborationMode('lifecycle', 'plan'), /Codex/);
  assert.throws(() => manager.create({ projectPath: process.cwd(), prompt: 'test', codexCollaborationMode: 'unknown' } as never), /不正/);
});

for (const fails of [false, true]) test(`Claude query ${fails ? 'failure' : 'completion'} aborts checks before publishing terminal status`, async () => {
  const controller = new AbortController();
  let state = session();
  const hub = { get: () => state, update: (_id: string, patch: Partial<Session>) => {
    if (patch.status === 'done' || patch.status === 'error') assert.equal(controller.signal.aborted, true);
    state = { ...state, ...patch }; return state;
  }, timeline: () => {} } as unknown as Hub;
  const runner = new ClaudeRunner(state, hub);
  const internal = runner as unknown as { q: AsyncIterable<unknown>; verificationAbort: AbortController; consume(): Promise<void> };
  internal.verificationAbort = controller;
  internal.q = { async *[Symbol.asyncIterator]() { if (fails) throw Error('fixture error'); } };
  await internal.consume();
  assert.equal(state.status, fails ? 'error' : 'done');
});

test('Codex rerouting updates actual model and reason without inventing effort; ignores other and stale turns', () => {
  let state = { ...session(), agent: 'codex' as const, effectiveModel: 'previous', reasoningEffort: 'high' };
  const timeline: TimelineItem[] = [];
  const hub = { get: () => state, update: (_id: string, patch: Partial<Session>) => { state = { ...state, ...patch } as typeof state; return state; }, timeline: (item: TimelineItem) => timeline.push(item) } as unknown as Hub;
  const runner = new CodexRunner(state, hub);
  const internal = runner as unknown as { threadId: string; turnId: string; onNotification(method: string, p: object): void };
  internal.threadId = 'thread'; internal.turnId = 'current';
  const params = { threadId: 'thread', turnId: 'current', fromModel: 'previous', toModel: 'actual', reason: 'highRiskCyberActivity' };
  internal.onNotification('model/rerouted', { ...params, threadId: 'child' });
  internal.onNotification('model/rerouted', { ...params, turnId: 'stale' });
  assert.equal(state.effectiveModel, 'previous');
  internal.onNotification('model/rerouted', params);
  assert.equal(state.effectiveModel, 'actual');
  assert.equal(state.reasoningEffort, null);
  assert.match(timeline[0].detail!, /サイバー/);
});
