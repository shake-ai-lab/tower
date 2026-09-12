import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCommand, unwrapShell } from './humanize.ts';

// 実際に Codex が送ってきた形（本体の場所の \ は二重）
const PS = '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command';

test('Codex が PowerShell で包んだコマンドから中身を取り出す', () => {
  assert.equal(unwrapShell(`${PS} 'npm test -- --test-isolation=none'`), 'npm test -- --test-isolation=none');
  assert.equal(unwrapShell(`${PS} "Get-Location; rg --files -g README.md; git status --short"`), 'Get-Location; rg --files -g README.md; git status --short');
  assert.equal(unwrapShell('bash -lc "ls -la"'), 'ls -la');
  assert.equal(unwrapShell('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "npm run build"'), 'npm run build');
  assert.equal(unwrapShell('npm test'), 'npm test', '包まれていなければそのまま');
});

test('包みを外してから日本語の一言を作る（今いる場所を出すだけの前置きは飛ばす）', () => {
  assert.equal(describeCommand(`${PS} 'npm test -- --test-isolation=none'`), 'テストを実行しています（npm test -- --test-isolation=none）');
  assert.equal(describeCommand(`${PS} 'git diff --check; git diff --stat'`), '差分を見ています（git diff --check; git diff --stat）');
  assert.match(describeCommand(`${PS} "Get-Location; rg --files -g README.md"`), /^コードを検索しています/);
});
