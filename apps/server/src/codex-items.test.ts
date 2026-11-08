import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { generatedImageDisplay, mergeAgentStates } from './agents/codex-items.ts';

test('画像生成は失敗・上限・保存先欠落を成功画像として扱わない', () => {
  const failed = generatedImageDisplay({ status: 'failed', savedPath: 'old.png' }, process.cwd());
  assert.equal(failed.kind, 'error');
  assert.equal(failed.imagePath, undefined);
  const limited = generatedImageDisplay({ status: 'completed', failure: { type: 'usageLimitExceeded', limitId: 'image' } }, process.cwd());
  assert.equal(limited.kind, 'error');
  assert.match(limited.detail!, /利用上限/);
  const absent = generatedImageDisplay({ status: 'completed', result: 'not a documented file path' }, process.cwd());
  assert.equal(absent.imagePath, undefined);
  assert.match(absent.text, /保存先/);
  const success = generatedImageDisplay({ status: 'completed', savedPath: '日本語.png' }, process.cwd());
  assert.equal(success.imagePath, path.join(process.cwd(), '日本語.png'));
  assert.equal(success.kind, 'tool_result');
});

test('サブエージェント呼出完了は子の完了を意味しない。失敗・結果を保持する', () => {
  const running = mergeAgentStates([], { status: 'completed', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } });
  assert.equal(running[0].status, 'running');
  const next = mergeAgentStates(running, { receiverThreadIds: ['second'], agentsStates: { second: { status: 'errored', message: 'command failed' } } });
  assert.deepEqual(next.map(a => a.status), ['running', 'errored']);
  assert.equal(next[1].message, 'command failed');
  const completed = mergeAgentStates(next, { agentsStates: { child: { status: 'completed', message: 'verified' } } });
  assert.equal(completed[0].message, 'verified');
  assert.equal(next[0].status, 'running', '前のsnapshotは変更しない');
});
