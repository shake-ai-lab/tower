import test from 'node:test';
import assert from 'node:assert/strict';
import { describePermission, describeSubagentProgress, summarizeToolResult, wantPhrase } from './humanize.ts';

test('許可の見出し: コマンドの中身から作った一言は「〜したい」にして動詞を重ねない', () => {
  assert.equal(wantPhrase('スクリプトを実行しています'), 'スクリプトを実行したい');
  assert.equal(wantPhrase('git の状態を見ています'), 'git の状態を見たい');
  assert.equal(wantPhrase('最新の変更を取り込んでいます'), '最新の変更を取り込みたい');
  assert.equal(wantPhrase('プロセスを止めています'), 'プロセスを止めたい');
  const r = describePermission('Bash', { command: 'python -c "print(1)"', description: 'Check the value' });
  assert.equal(r.headline, 'スクリプトを実行したい（python -c "print(1)"）');
});

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
