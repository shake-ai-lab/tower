import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectChanges } from './diff.ts';
import { git } from './worktree.ts';
import { instructionLine, replyReport } from './report.ts';
import { assessRisk } from './humanize.ts';
import { listDir } from './files.ts';

test('changes are listed relative to the work folder even when it is a subfolder of the repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-sub-'));
  const run = (...args: string[]) => { const r = git(root, args); assert.ok(r.ok, r.err); return r.out; };
  try {
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'f.txt'), 'one\n');
    fs.writeFileSync(path.join(root, 'top.txt'), 'top\n');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(root, 'sub', 'f.txt'), 'two\n');
    fs.writeFileSync(path.join(root, 'sub', 'g.txt'), 'new\n');
    fs.writeFileSync(path.join(root, 'top.txt'), 'changed\n');
    fs.writeFileSync(path.join(root, 'h.txt'), 'untracked at root\n');

    const sub = collectChanges(path.join(root, 'sub'), []);
    assert.equal(sub.isGit, true);
    assert.deepEqual(sub.files.map((f) => [f.path, f.status]).sort(), [['f.txt', 'M'], ['g.txt', 'A']]);
    const modified = sub.files.find((f) => f.path === 'f.txt')!;
    assert.match(modified.diff, /-one/);
    assert.match(modified.diff, /\+two/);

    const whole = collectChanges(root, []);
    assert.deepEqual(whole.files.map((f) => f.path).sort(), ['h.txt', 'sub/f.txt', 'sub/g.txt', 'top.txt']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('changes come from one git diff split per file: renames, deletions, spaces and Japanese names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-split-'));
  const run = (...args: string[]) => { const r = git(root, args); assert.ok(r.ok, r.err); return r.out; };
  try {
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    run('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(root, 'old name.txt'), 'same\ncontent\nhere\n');
    fs.writeFileSync(path.join(root, '日本語.md'), 'まえ\n');
    fs.writeFileSync(path.join(root, 'gone.txt'), 'bye\n');
    fs.writeFileSync(path.join(root, 'tricky.txt'), 'x\n');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
    run('mv', 'old name.txt', 'new name.txt');
    fs.writeFileSync(path.join(root, '日本語.md'), 'あと\n');
    fs.rmSync(path.join(root, 'gone.txt'));
    // 本文に見出しそっくりの行（差分では「+++ b/日本語.md」になる）を足しても、別のファイルと取り違えない
    fs.writeFileSync(path.join(root, 'tricky.txt'), 'x\n++ b/日本語.md\n');

    const by = Object.fromEntries(collectChanges(root, []).files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(by).sort(), ['gone.txt', 'new name.txt', 'tricky.txt', '日本語.md']);
    assert.match(by['日本語.md'].diff, /^-まえ$/m);
    assert.match(by['日本語.md'].diff, /^\+あと$/m);
    assert.doesNotMatch(by['日本語.md'].diff, /tricky/);
    assert.equal(by['gone.txt'].status, 'D');
    assert.match(by['gone.txt'].diff, /^-bye$/m);
    assert.match(by['new name.txt'].diff, /名前だけ変わりました: old name\.txt → new name\.txt/);
    assert.match(by['tricky.txt'].diff, /^\+\+\+ b\/日本語\.md$/m);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the reply is kept word for word: no format is read out of it and nothing is rewritten', () => {
  const text = '## できたこと\n\n`src/app.ts` を直しました。\n\n```ts\nconst a = 1;\n```\n\n【報告】\n結果: 完了';
  const r = replyReport(text, instructionLine('ボタンを直して\n\n（補足: Tower からのメモ）'), ['C:/p/src/app.ts'], false);
  assert.equal(r.raw, text);
  assert.equal(r.request, 'ボタンを直して');
  assert.equal(r.outcome, 'unknown');
  assert.deepEqual(r.summary, []);
  assert.equal(r.needsDecision, null);
  assert.deepEqual(r.changedFiles, ['C:/p/src/app.ts']);
  assert.equal(replyReport('止まりました', 'x', [], true).outcome, 'failed');
});

test('ordinary "format" commands are not flagged as dangerous, formatting a drive is', () => {
  assert.notEqual(assessRisk('Bash', { command: 'npm run format' }), 'high');
  assert.notEqual(assessRisk('Bash', { command: 'git log --format=%H' }), 'high');
  assert.equal(assessRisk('Bash', { command: 'format D: /q' }), 'high');
});

test('junctions inside the project are folders; junctions pointing outside are hidden', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-junction-'));
  try {
    const root = path.join(temp, 'project');
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'inner'), 'junction');
    fs.symlinkSync(outside, path.join(root, 'node_modules'), 'junction');
    const tree = listDir(root, '');
    assert.deepEqual(tree.entries.map((e) => [e.name, e.kind]), [['inner', 'dir'], ['real', 'dir']]);
    assert.deepEqual(tree.skipped, ['node_modules']);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
