import test from 'node:test';
import assert from 'node:assert/strict';
import { firstReplyLine, replyExcerpt } from './src/lib.ts';
import { findFileRefs, shortPath, toWorkPath } from './src/reply-links.ts';

test('the first meaningful line of a reply, without Markdown symbols', () => {
  assert.equal(firstReplyLine('直しました。\n\n詳しくは下に'), '直しました。');
  assert.equal(firstReplyLine('\n\n## 変更内容\n\n- **`src/app.ts`** の [読み込み](src/app.ts) を直しました\n'), 'src/app.ts の 読み込み を直しました');
  // 見出ししか無ければ見出し
  assert.equal(firstReplyLine('# 完了しました'), '完了しました');
  // コードの塊・区切り線・表の区切りは飛ばす
  assert.equal(firstReplyLine('```ts\nconst a = 1;\n```\n---\n> *注意*: テストは通っています'), '注意: テストは通っています');
  assert.equal(firstReplyLine('| 名前 | 結果 |\n|---|---|\n| a | ok |'), '名前 / 結果');
  assert.equal(firstReplyLine('1. [x] 一つ目を終えた'), '一つ目を終えた');
  assert.equal(firstReplyLine('   \n'), '');
  // snake_case や掛け算の * は消さない
  assert.equal(firstReplyLine('`max_retry_count` を 2 * 3 にしました'), 'max_retry_count を 2 * 3 にしました');
});

test('reply excerpt: old structured reports keep 判断が必要 → やったこと, new replies use the first line', () => {
  const old = { needsDecision: 'どちらにしますか', summary: ['A を直した'], raw: '【報告】…' };
  assert.equal(replyExcerpt(old), 'どちらにしますか');
  assert.equal(replyExcerpt(old, false), 'A を直した');
  assert.equal(replyExcerpt({ needsDecision: null, summary: [], raw: '## 結果\n**直しました**。テストも通っています' }), '直しました。テストも通っています');
});

test('file paths in reply text: needs a folder separator and an extension, skips URLs', () => {
  const tokens = (t: string) => findFileRefs(t).map((h) => h.token);
  assert.deepEqual(tokens('src/app.ts と docs/x.md を直しました。'), ['src/app.ts', 'docs/x.md']);
  assert.deepEqual(tokens('C:\\proj\\shots\\a.png を見てください'), ['C:\\proj\\shots\\a.png']);
  assert.deepEqual(tokens('これはsrc/app.tsです（apps/web/src/lib.ts:42 も）'), ['src/app.ts', 'apps/web/src/lib.ts:42']);
  assert.deepEqual(tokens('https://example.com/a/b.html と www.example.com/x.js は除く'), []);
  assert.deepEqual(tokens('Node.js や e.g. や 2026/11/08 や v1.2 や and/or は拾わない'), []);
  assert.deepEqual(tokens('see ./scripts/run.sh.'), ['./scripts/run.sh']);
});

test('paths become relative to the work folder; outside it (or not a file) they are not linked', () => {
  const root = 'C:\\Users\\me\\proj';
  assert.deepEqual(toWorkPath('src/app.ts', root), { path: 'src/app.ts' });
  assert.deepEqual(toWorkPath('./src\\app.ts:12', root), { path: 'src/app.ts', line: 12 });
  assert.deepEqual(toWorkPath('C:\\Users\\me\\proj\\shots\\a.png', root), { path: 'shots/a.png' });
  assert.deepEqual(toWorkPath('c:/users/ME/proj/docs/x.md#L3', root), { path: 'docs/x.md', line: 3 });
  assert.deepEqual(toWorkPath('/c/Users/me/proj/a.ts', root), { path: 'a.ts' });
  assert.deepEqual(toWorkPath('file:///C:/Users/me/proj/My%20Shots/b.png', root), { path: 'My Shots/b.png' });
  assert.equal(toWorkPath('C:\\Users\\me\\other\\a.ts', root), null);
  assert.equal(toWorkPath('C:\\Users\\me\\proj-2\\a.ts', root), null);
  assert.equal(toWorkPath('../outside/a.ts', root), null);
  assert.equal(toWorkPath('https://example.com/a.ts', root), null);
  assert.equal(toWorkPath('src/Makefile', root), null);
  assert.equal(toWorkPath('~/notes/a.md', root), null);
  // 区切りの無い名前は `コード` の中だけ、決まった拡張子のものだけ
  assert.equal(toWorkPath('package.json', root), null);
  assert.deepEqual(toWorkPath('package.json', root, { bare: true }), { path: 'package.json' });
  assert.deepEqual(toWorkPath('.env', root, { bare: true }), { path: '.env' });
  for (const code of ['console.log', 'process.env', 's.report', 'foo.bar()', 'npm run build.js']) assert.equal(toWorkPath(code, root, { bare: true }), null, code);
  // 作業フォルダが Linux / mac の書き方でも
  assert.deepEqual(toWorkPath('/home/me/proj/src/a.ts', '/home/me/proj/'), { path: 'src/a.ts' });
});

test('changed files are shown relative to the work folder when inside it', () => {
  assert.equal(shortPath('C:\\Users\\me\\proj\\src\\a.ts', 'C:\\Users\\me\\proj'), 'src/a.ts');
  assert.equal(shortPath('D:\\x\\b.ts', 'C:\\Users\\me\\proj'), 'D:\\x\\b.ts');
  assert.equal(shortPath('src/a.ts', 'C:\\Users\\me\\proj'), 'src/a.ts');
});
