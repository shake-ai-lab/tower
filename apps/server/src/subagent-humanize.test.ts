import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSubagentProgress, summarizeToolResult } from './humanize.ts';

test('サブエージェントの途中経過: 英語なら使っている道具から日本語の一言を作る', () => {
  assert.equal(describeSubagentProgress('Grepping for TODO markers', 'Grep'), 'サブエージェントがコードを検索しています（Grepping for TODO markers）');
  assert.equal(describeSubagentProgress('Reading files'), 'サブエージェントが作業しています（Reading files）');
  assert.equal(describeSubagentProgress('設定を読んでいます', 'Read'), 'サブエージェント: 設定を読んでいます');
});

test('サブエージェントの結果: 裏で動かし始めた時の内部向けの英文は見せない', () => {
  const launched = [{ type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it)\nagentId: abc' }];
  assert.equal(summarizeToolResult(launched, 'Agent', {}), 'サブエージェントを裏で動かし始めました（終わると続きを書きます）');
  assert.equal(summarizeToolResult('調べた結果です\n2 行目', 'Task', {}), 'サブエージェントが結果を返しました（2 行）');
});
