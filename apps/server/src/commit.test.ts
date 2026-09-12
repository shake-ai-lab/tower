import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Report, Session } from '@tower/shared';
import { commitMessage, commitTaskWork, commitsInOutput, directChanges, isCommitCommand, linkTasks, parseStatusZ, taskIdOf } from './commit.ts';
import { collectHistory } from './diff.ts';
import { git } from './worktree.ts';

const ID = '12345678-aaaa-bbbb-cccc-1234567890ab';

function repo() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-commit-')));
  const run = (...args: string[]) => {
    const r = git(root, args);
    assert.ok(r.ok, r.err);
    return r.out;
  };
  const write = (f: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  };
  run('init', '-b', 'main');
  run('config', 'user.name', 'Tower Test');
  run('config', 'user.email', 'test@example.invalid');
  return { root, run, write, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function session(root: string, patch: Partial<Session> = {}): Session {
  return {
    id: ID, agent: 'claude', agentSessionId: null, project: { path: root, name: 'p' }, title: 'ボタンの色を変える', prompt: 'ボタンの色を変える',
    model: null, permissionMode: 'acceptEdits', status: 'idle', activity: '', pending: null, report: null, turns: 1, costUsd: 0, toolCalls: 0,
    changedFiles: [], createdAt: 0, updatedAt: 0, lastError: null, ...patch,
  };
}

const report = (patch: Partial<Report> = {}): Report => ({
  request: 'ボタンの色を青にする', outcome: 'done', summary: ['ボタンを青にした', '押した時の色も合わせた'], changedFiles: [],
  needsDecision: null, nextStep: null, raw: '', generatedAt: 1, ...patch,
});

test('commit message: what was asked, what was done, and the task mark on the last line', () => {
  const msg = commitMessage(session('/p'), report());
  assert.equal(msg, `ボタンの色を青にする\n\n- ボタンを青にした\n- 押した時の色も合わせた\n\nTower-Task: ${ID}`);
  assert.equal(taskIdOf(msg), ID);
  assert.match(commitMessage(session('/p'), report({ outcome: 'partial' })), /^（途中）ボタンの色を青にする/);
  assert.match(commitMessage(session('/p'), report({ outcome: 'failed', summary: [] })), new RegExp(`^（失敗）ボタンの色を青にする\\n\\nTower-Task: ${ID}$`));
  assert.equal(taskIdOf('Fix a bug\n\nNo mark here'), null);
});

test('an agent\'s own git commit is picked up from the command output', () => {
  assert.deepEqual(commitsInOutput('[main 1a2b3c4] 色を変更\n 2 files changed, 3 insertions(+)'), [{ short: '1a2b3c4', subject: '色を変更' }]);
  assert.deepEqual(commitsInOutput('[main (root-commit) abcdef1] Initial\r\n'), [{ short: 'abcdef1', subject: 'Initial' }]);
  assert.deepEqual(commitsInOutput('On branch main\nnothing to commit'), []);
  assert.ok(isCommitCommand('git add a.txt && git commit -m "x"'));
  assert.ok(isCommitCommand('git -C sub commit -m x'));
  assert.ok(!isCommitCommand('git log --oneline'));
  assert.ok(!isCommitCommand('echo commit'));
});

test('status -z keeps the leading space of the code and both names of a rename', () => {
  assert.deepEqual(parseStatusZ(' M a.txt\0?? b c.txt\0R  new.txt\0old.txt\0'), ['a.txt', 'b c.txt', 'new.txt', 'old.txt']);
});

test('working in the project folder: records only the files this task touched, leaves others as they were, and the graph knows the task', () => {
  const { root, run, write, done } = repo();
  try {
    write('a.txt', '1\n'); write('b.txt', '1\n'); write('c.txt', '1\n');
    run('add', '.'); run('commit', '-m', 'init');
    // このタスク: a.txt を変え、src/new.txt を作った。b.txt は利用者の書きかけ、c.txt は利用者がステージしたもの
    write('a.txt', '2\n'); write('src/new.txt', 'new\n'); write('b.txt', '2\n'); write('c.txt', '2\n');
    run('add', 'c.txt');
    const s = session(root, { changedFiles: [path.join(root, 'a.txt'), 'src/new.txt'] });
    const r = commitTaskWork(s, report());
    assert.equal(r.kind, 'committed');
    if (r.kind !== 'committed') return;
    assert.deepEqual([...r.files].sort(), ['a.txt', 'src/new.txt']);
    assert.equal(r.commit.hash, run('rev-parse', 'HEAD'));
    assert.equal(r.commit.subject, 'ボタンの色を青にする');
    assert.deepEqual(run('show', '--name-only', '--format=', 'HEAD').split(/\r?\n/).sort(), ['a.txt', 'src/new.txt']);
    assert.equal(taskIdOf(run('log', '-1', '--format=%B')), ID);
    const status = git(root, ['status', '--porcelain'], { raw: true }).out;
    assert.match(status, /^ M b\.txt$/m);
    assert.match(status, /^M  c\.txt$/m);
    // もう記録するものが無ければ黙って見送る
    assert.deepEqual(commitTaskWork(s, report()), { kind: 'skipped', message: null });

    // 記録した後も、タスクの変更（記録した分も）が見える。他の人の記録（d.txt）は混ぜない。まだ記録していない変更は出す
    const mine = { ...s, commits: [r.commit] };
    run('reset', '-q', 'c.txt');
    write('d.txt', 'other\n'); run('add', 'd.txt'); run('commit', '-m', 'someone else');
    const changes = directChanges(mine);
    assert.deepEqual(changes.files.map((f) => f.path).sort(), ['a.txt', 'b.txt', 'c.txt', 'src/new.txt']);
    assert.match(changes.files.find((f) => f.path === 'a.txt')!.diff, /-1\n\+2/);
    assert.match(changes.against ?? '', /記録（コミット）した分も含みます/);

    // グラフ: タスクが覚えているコミットにも、印だけのコミット（タスクを消した後）にも、タスクが付く
    const linked = linkTasks(collectHistory(root), [mine]);
    assert.deepEqual(linked.find((h) => h.hash === r.commit.hash)?.task, { id: ID, title: 'ボタンの色を変える' });
    assert.equal(linked.find((h) => h.subject === 'someone else')?.task, undefined);
    assert.deepEqual(linkTasks(collectHistory(root), []).find((h) => h.hash === r.commit.hash)?.task, { id: ID, title: null });
  } finally {
    done();
  }
});

test('a separate workspace belongs to the task, so everything in it is recorded', () => {
  const { root, run, write, done } = repo();
  try {
    write('a.txt', '1\n'); run('add', '.'); run('commit', '-m', 'init');
    write('a.txt', '2\n'); write('made-by-command.txt', 'x\n');
    const s = session(root, { workspace: { path: root, root, branch: 'main', baseBranch: 'main', baseCommit: '', lastMerge: null } });
    const r = commitTaskWork(s, report());
    assert.equal(r.kind, 'committed');
    assert.deepEqual(run('show', '--name-only', '--format=', 'HEAD').split(/\r?\n/).sort(), ['a.txt', 'made-by-command.txt']);
  } finally {
    done();
  }
});

test('in the middle of a git merge, nothing is recorded and the task is told why', () => {
  const { root, run, write, done } = repo();
  try {
    write('a.txt', '1\n'); run('add', '.'); run('commit', '-m', 'init');
    run('checkout', '-q', '-b', 'other'); write('a.txt', 'other\n'); run('commit', '-qam', 'other');
    run('checkout', '-q', 'main'); write('a.txt', 'main\n'); run('commit', '-qam', 'main');
    assert.ok(!git(root, ['merge', 'other']).ok);
    const r = commitTaskWork(session(root, { changedFiles: ['a.txt'] }), report());
    assert.equal(r.kind, 'skipped');
    assert.match(r.kind === 'skipped' ? (r.message ?? '') : '', /合流/);
  } finally {
    done();
  }
});
