import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '@tower/shared';
import { CodexRunner } from './agents/codex.ts';
import { RpcError } from './agents/codex-rpc.ts';
import type { Hub } from './hub.ts';

for (const error of [new Error('Connection closed'), new RpcError('Thread not found', -32600), new RpcError('Rate limit', -32000)]) {
  test(`会話の再開失敗でthread/startへ逃げず元の会話を保持する: ${error.message}`, async () => {
    let session = { id: 'resume-test', agentSessionId: 'original-thread', permissionMode: 'default' } as Session;
    const hub = {
      get: () => session,
      update: (_id: string, patch: Partial<Session>) => { session = { ...session, ...patch }; return session; },
      timeline: () => {},
    } as unknown as Hub;
    const runner = new CodexRunner(session, hub);
    const calls: string[] = [];
    const internal = runner as unknown as {
      rpc: unknown;
      openThread(common: Record<string, unknown>, resumeFrom?: string): Promise<string>;
      fail(error: unknown): void;
    };
    internal.rpc = { request: async (method: string) => { calls.push(method); throw error; }, close: () => {} };
    const failure = await internal.openThread({}, 'original-thread').catch((e: unknown) => e);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /前の会話を再開できませんでした/);
    internal.fail(failure);
    assert.deepEqual(calls, ['thread/resume']);
    assert.equal(session.agentSessionId, 'original-thread');
    assert.equal(session.status, 'error');
    assert.match(session.lastError!, /会話は保持しています/);
  });
}

test('再試行でthread/resumeが成功した時だけ返された会話IDを使う', async () => {
  let session = { id: 'resume-test', agentSessionId: 'original-thread', permissionMode: 'default' } as Session;
  const runner = new CodexRunner(session, { get: () => session, update: (_id: string, patch: Partial<Session>) => { session = { ...session, ...patch }; } } as unknown as Hub);
  const calls: { method: string; params: unknown }[] = [];
  const internal = runner as unknown as { rpc: unknown; openThread(common: Record<string, unknown>, resumeFrom?: string): Promise<string> };
  internal.rpc = { request: async (method: string, params: unknown) => { calls.push({ method, params }); return { thread: { id: 'original-thread' }, model: 'effective-model', reasoningEffort: 'high' }; } };
  assert.equal(await internal.openThread({ sandbox: 'read-only' }, 'original-thread'), 'original-thread');
  assert.deepEqual(calls, [{ method: 'thread/resume', params: { threadId: 'original-thread', sandbox: 'read-only', excludeTurns: true } }]);
  assert.equal(session.effectiveModel, 'effective-model');
  assert.equal(session.reasoningEffort, 'high');
});
