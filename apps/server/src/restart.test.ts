import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '@tower/shared';
import { interruptForRestart } from './hub.ts';
import { pickInterrupted } from './manager.ts';
import { validateSettings } from './config.ts';

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
    status: 'running',
    activity: '作業中',
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

test('interruptForRestart marks a running session as stopped with the interrupted flag', () => {
  const pending = { id: 'r', kind: 'permission' as const, toolName: 'Bash', input: {}, headline: 'h', detail: 'd', risk: 'low' as const, canAlwaysAllow: false, alwaysRules: [], createdAt: 1 };
  const r = interruptForRestart(session({ status: 'running', pending, pendingCount: 1, updatedAt: 42 }), 100);
  assert.ok(r);
  assert.equal(r.status, 'stopped');
  assert.deepEqual(r.interrupted, { at: 100, status: 'running' });
  assert.equal(r.pending, null);
  assert.equal(r.pendingCount, 0);
  assert.equal(r.updatedAt, 42);
  assert.match(r.activity, /指示を送ると続きから再開します/);
});

test('interruptForRestart leaves idle and external sessions alone', () => {
  assert.equal(interruptForRestart(session({ status: 'idle' }), 100), null);
  assert.equal(interruptForRestart(session({ status: 'stopped' }), 100), null);
  assert.equal(interruptForRestart(session({ status: 'running', origin: 'external' }), 100), null);
});

test('restart normalizes unfinished verification and baseline even on idle sessions', () => {
  const check = { command: 'npm test', ok: null, output: 'partial output', at: 10, durationMs: 0 };
  for (const status of ['idle', 'running', 'done'] as const) {
    const result = interruptForRestart(session({ status, verification: check, baseline: check }), 100)!;
    assert.equal(result.verification?.ok, false);
    assert.equal(result.baseline?.ok, false);
    assert.match(result.verification!.summary!, /中断/);
    assert.match(result.verification!.output, /partial output/);
    assert.equal(result.verification?.durationMs, 90);
    assert.equal(result.status, status === 'running' ? 'stopped' : status);
    assert.equal(result.updatedAt, 1);
  }
  assert.equal(interruptForRestart(session({ origin: 'external', verification: check }), 100), null);
  const success = { ...check, ok: true };
  assert.equal(interruptForRestart(session({ status: 'idle', verification: success }), 100), null);
});

test('interruptForRestart clears unfinished Codex output saved before a crash', () => {
  const r = interruptForRestart(session({ agent: 'codex', liveOutput: [{ itemId: 'old', kind: 'command_output', text: 'running tests', truncated: false }] }), 100);
  assert.equal(r?.liveOutput, null);
  assert.equal(r?.agentSessionId, 'agent-1');
});

test('interruptForRestart says it cannot resume when the agent session id is missing', () => {
  const r = interruptForRestart(session({ status: 'waiting_permission', agentSessionId: null }), 100);
  assert.ok(r);
  assert.equal(r.interrupted?.status, 'waiting_permission');
  assert.match(r.activity, /再開不可/);
});

test('pickInterrupted keeps only resumable interrupted sessions, newest first', () => {
  const flag = { at: 100, status: 'running' as const };
  const stale = { at: 99, status: 'running' as const };
  const older = session({ id: 'older', interrupted: flag, updatedAt: 10 });
  const newer = session({ id: 'newer', interrupted: flag, updatedAt: 20 });
  const picked = pickInterrupted([
    older,
    session({ id: 'not-interrupted', updatedAt: 99 }),
    session({ id: 'external', origin: 'external', interrupted: flag, updatedAt: 99 }),
    session({ id: 'no-agent-id', agentSessionId: null, interrupted: flag, updatedAt: 99 }),
    session({ id: 'already-resumed', autoResumes: 1, interrupted: flag, updatedAt: 99 }),
    session({ id: 'stale-flag', interrupted: stale, updatedAt: 99 }),
    newer,
  ], 100);
  assert.deepEqual(picked.map((s) => s.id), ['newer', 'older']);
});

test('validateSettings accepts autoResume', () => {
  assert.equal(validateSettings({ autoResume: false }).autoResume, false);
  assert.equal(validateSettings({ autoResume: true }).autoResume, true);
  assert.equal(validateSettings({}).autoResume, undefined);
});
