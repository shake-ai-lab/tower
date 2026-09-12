import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session, SessionStatus } from '@tower/shared';
import { ago, pickerGroups } from './src/task-picker.ts';

const task = (id: string, project: string, title: string, status: SessionStatus = 'idle', path = `C:/p/${project}`) =>
  ({ id, project: { name: project, path }, title, prompt: title, status }) as unknown as Session;

const ids = (r: ReturnType<typeof pickerGroups>) => r.groups.map((g) => [g.project.name, g.sessions.map((s) => s.id)]);

test('tasks are grouped by project, keeping the given (priority) order', () => {
  const list = [task('a', 'editor', 'A', 'waiting_permission'), task('b', 'site', 'B', 'running'), task('c', 'editor', 'C')];
  assert.deepEqual(ids(pickerGroups(list, '', false)), [['editor', ['a', 'c']], ['site', ['b']]]);
});

test('same project name in different folders stays separate', () => {
  const list = [task('a', 'editor', 'A', 'idle', 'C:/one/editor'), task('b', 'editor', 'B', 'idle', 'C:/two/editor')];
  assert.equal(pickerGroups(list, '', false).groups.length, 2);
});

test('finished tasks are folded away unless asked for or searched', () => {
  const list = [task('a', 'editor', '進めろって', 'stopped'), task('b', 'editor', 'ダークモード', 'running'), task('c', 'site', 'X', 'error')];
  const folded = pickerGroups(list, '', false);
  assert.deepEqual(ids(folded), [['editor', ['b']]]);
  assert.equal(folded.hiddenFinished, 2);
  assert.deepEqual(ids(pickerGroups(list, '', true)), [['editor', ['a', 'b']], ['site', ['c']]]);
  assert.deepEqual(ids(pickerGroups(list, '進め', false)), [['editor', ['a']]]);
});

test('search matches project name and title, every word must match', () => {
  const list = [task('a', 'editor', 'Git のグラフ'), task('b', 'site', 'git の設定'), task('c', 'editor', 'ダークモード')];
  assert.deepEqual(ids(pickerGroups(list, 'GIT', false)), [['editor', ['a']], ['site', ['b']]]);
  assert.deepEqual(ids(pickerGroups(list, 'editor git', false)), [['editor', ['a']]]);
  assert.deepEqual(ids(pickerGroups(list, 'なし', false)), []);
});

test('ago is short and readable', () => {
  const now = 10 * 86_400_000;
  assert.equal(ago(now - 20_000, now), 'たった今');
  assert.equal(ago(now - 5 * 60_000, now), '5分前');
  assert.equal(ago(now - 3 * 3_600_000 - 12 * 60_000, now), '3時間前');
  assert.equal(ago(now - 2 * 86_400_000, now), '2日前');
  assert.equal(ago(now + 5000, now), 'たった今');
});
