import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listAllFiles, searchText } from './search.ts';
import { lineMarks, parseLineMarks } from './diff.ts';
import { git } from './worktree.ts';

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-search-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function commit(root: string) {
  git(root, ['init', '-q']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['add', '-A']);
  assert.ok(git(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init']).ok);
}

test('file list follows .gitignore, skips heavy folders; search finds every hit with its line and column', () => {
  const root = project({
    'src/App.tsx': 'const title = "Hello";\nexport default title;\n',
    'docs/guide.md': '# 使い方\nhello again, HELLO\n',
    'dist/out.js': 'hello from build',
    'node_modules/x/index.js': 'hello',
    '.gitignore': 'dist/\n',
    'pic.png': 'hello',
  });
  try {
    commit(root);
    fs.writeFileSync(path.join(root, 'new.txt'), 'not committed yet: hello');
    assert.deepEqual(listAllFiles(root).files, ['.gitignore', 'docs/guide.md', 'new.txt', 'pic.png', 'src/App.tsx']);
    const r = searchText(root, 'hello');
    assert.equal(r.total, 4);
    assert.equal(r.truncated, false);
    const guide = r.files.find((f) => f.path === 'docs/guide.md')!;
    assert.deepEqual(guide.matches.map((m) => [m.line, m.column, m.text.slice(m.at, m.at + m.length)]), [[2, 1, 'hello'], [2, 14, 'HELLO']]);
    assert.equal(searchText(root, 'HELLO', true).total, 1);
    assert.equal(searchText(root, '使い方').files[0].path, 'docs/guide.md');
    assert.equal(searchText(root, '').total, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('without git the file list walks folders and still skips node_modules', () => {
  const root = project({ 'a/b.txt': 'x', 'node_modules/y.js': 'x', 'c.md': 'x' });
  try {
    assert.deepEqual(listAllFiles(root).files, ['a/b.txt', 'c.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('line marks: changed, added and removed lines against the last commit', () => {
  const root = project({ 'a.txt': 'one\ntwo\nthree\nfour\nfive\n', '.gitignore': 'secret.txt\n' });
  try {
    commit(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\nthree\nfive\nsix\n');
    assert.deepEqual(lineMarks(root, 'a.txt'), [
      { kind: 'modified', start: 2, end: 2 },
      { kind: 'deleted', start: 3, end: 3 },
      { kind: 'added', start: 5, end: 5 },
    ]);
    fs.writeFileSync(path.join(root, 'new.txt'), 'a\nb\n');
    assert.deepEqual(lineMarks(root, 'new.txt'), [{ kind: 'added', start: 1, end: 2 }]);
    fs.writeFileSync(path.join(root, 'secret.txt'), 'a\n');
    assert.deepEqual(lineMarks(root, 'secret.txt'), []);
    assert.throws(() => lineMarks(root, '../outside.txt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const plain = project({ 'a.txt': 'x' });
  try {
    assert.equal(lineMarks(plain, 'a.txt'), null);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('line marks parser handles hunks without counts and removals at the top', () => {
  assert.deepEqual(parseLineMarks('@@ -3 +3 @@\n-a\n+b\n@@ -1,2 +0,0 @@\n-x\n-y\n@@ -7,1 +6,3 @@\n'), [
    { kind: 'modified', start: 3, end: 3 },
    { kind: 'deleted', start: 1, end: 1 },
    { kind: 'modified', start: 6, end: 6 },
    { kind: 'added', start: 7, end: 8 },
  ]);
});
