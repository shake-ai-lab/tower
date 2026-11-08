// 使い続けると溜まるものの片付け: 指示待ちのプロセス・使っていない作業場所・自動の記録に入れる大きなファイル
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 本物の ~/.tower（利用者の作業場所）に触らないよう、読み込む前に置き場所を一時フォルダへ向ける
const DATA = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-housekeeping-')));
process.env.TOWER_DATA_DIR = DATA;

const { Db } = await import('./db.ts');
const { Hub } = await import('./hub.ts');
const { SessionManager } = await import('./manager.ts');
const { commitTaskWork } = await import('./commit.ts');
const { git, parkBlocker, parkWorktree, removeOrphanWorktrees, restoreWorktree, WORKTREE_ROOT } = await import('./worktree.ts');
import type { Session, Workspace } from '@tower/shared';
import type { AgentRunner } from './agents/types.ts';

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('the worktree root used by these tests is the temporary one, not the real ~/.tower', () => {
  assert.ok(WORKTREE_ROOT.startsWith(DATA));
});

function session(patch: Partial<Session>): Session {
  return {
    id: 'id', agent: 'claude', agentSessionId: 'agent-1', project: { path: DATA, name: 'p' }, title: 't', prompt: 'p', model: null,
    permissionMode: 'acceptEdits', status: 'idle', activity: '指示待ち', pending: null, pendingCount: 0, report: null, turns: 1, costUsd: 0,
    toolCalls: 0, changedFiles: [], createdAt: 1, updatedAt: 1, lastError: null, ...patch,
  };
}

/** 元のプロジェクト（main に 1 コミット）と、そこから分けた作業場所 */
function project(name: string) {
  const dir = path.join(DATA, name);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const run = (cwd: string, ...args: string[]) => {
    const r = git(cwd, args);
    assert.ok(r.ok, `${args.join(' ')}: ${r.err}`);
    return r.out;
  };
  run(repo, 'init', '-q', '-b', 'main');
  run(repo, 'config', 'user.name', 'Tower Test');
  run(repo, 'config', 'user.email', 'test@example.invalid');
  run(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\nworks/\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  run(repo, 'add', '-A');
  run(repo, 'commit', '-q', '-m', 'init');
  const base = run(repo, 'rev-parse', 'HEAD');
  const root = path.join(WORKTREE_ROOT, `${name}-wt`);
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true });
  run(repo, 'worktree', 'add', '-q', '-b', `tower/${name}`, root, 'HEAD');
  const ws: Workspace = { path: root, root, branch: `tower/${name}`, baseBranch: 'main', baseCommit: base, lastMerge: null };
  return { repo, root, ws, run };
}

/** 動いているエージェントの代わり。release に何と答えるかを決められる */
function fakeRunner(canRelease: boolean) {
  const calls: string[] = [];
  const runner = {
    start() {},
    send() {},
    async stop() {},
    release(force: boolean) {
      calls.push(`release:${force}`);
      return force || canRelease;
    },
    resolvePermission: () => false,
    answerQuestion: () => false,
  } as unknown as AgentRunner;
  return { runner, calls };
}

const runnersOf = (m: InstanceType<typeof SessionManager>) => (m as unknown as { runners: Map<string, AgentRunner> }).runners;

test('an agent that ended with an error has its process released, not just forgotten', () => {
  const hub = new Hub(new Db(':memory:'));
  const manager = new SessionManager(hub);
  hub.add(session({ id: 'e', status: 'running' }));
  const { runner, calls } = fakeRunner(false);
  runnersOf(manager).set('e', runner);
  hub.update('e', { status: 'error', lastError: 'usage limit reached' });
  assert.deepEqual(calls, ['release:true']);
  assert.equal(manager.runner('e'), undefined);
});

test('idle agents are released after a quiet period; busy, recent or working ones are kept', () => {
  const hub = new Hub(new Db(':memory:'));
  const manager = new SessionManager(hub);
  const now = Date.now();
  for (const id of ['old', 'recent', 'busy', 'working']) hub.add(session({ id, status: id === 'working' ? 'running' : 'idle' }));
  const runners = { old: fakeRunner(true), recent: fakeRunner(true), busy: fakeRunner(false), working: fakeRunner(true) };
  for (const [id, r] of Object.entries(runners)) runnersOf(manager).set(id, r.runner);
  // add は updatedAt = 1（ずっと前）のまま。recent だけ今動いたことにする
  hub.update('recent', { activity: '指示待ち' });
  const released = manager.releaseIdleRunners(now + 20 * 60_000);
  assert.deepEqual(released, ['old']);
  assert.equal(manager.runner('old'), undefined);
  assert.deepEqual(runners.old.calls, ['release:false']);
  assert.ok(manager.runner('recent'), '20 minutes is not long enough');
  assert.ok(manager.runner('busy'), 'a runner that is still busy says no');
  assert.ok(manager.runner('working'));
  assert.deepEqual(runners.working.calls, []);
});

test('a clean, unused workspace is parked (folder removed, branch kept) and rebuilt when opened again', async () => {
  const p = project('park');
  const hub = new Hub(new Db(':memory:'));
  const manager = new SessionManager(hub);
  // 作業を記録してから（ブランチに残る）、依存パッケージとビルドの出力（作り直せるもの）を置く
  fs.writeFileSync(path.join(p.root, 'a.txt'), 'two\n');
  p.run(p.root, 'commit', '-q', '-am', 'work');
  fs.mkdirSync(path.join(p.root, 'dist'));
  fs.writeFileSync(path.join(p.root, 'dist', 'out.js'), 'x');
  hub.add(session({ id: 'p', project: { path: p.repo, name: 'repo' }, workspace: p.ws, updatedAt: Date.now() }));
  assert.equal(parkBlocker(p.ws), null);

  // まだ新しいうちは片付けない
  assert.deepEqual(await manager.parkIdleWorkspaces(Date.now(), WORKTREE_ROOT), []);
  assert.ok(fs.existsSync(p.root));

  const parked = await manager.parkIdleWorkspaces(Date.now() + 4 * 86_400_000, WORKTREE_ROOT);
  assert.deepEqual(parked, ['p']);
  assert.ok(!fs.existsSync(p.root));
  assert.ok(git(p.repo, ['rev-parse', '--verify', '-q', 'refs/heads/tower/park']).ok, 'branch is kept');

  // 開くと作り直す（記録した作業がそのまま戻る）
  const s = manager.ensureWorkspace('p');
  assert.ok(s && fs.existsSync(p.root));
  assert.equal(fs.readFileSync(path.join(p.root, 'a.txt'), 'utf8'), 'two\n');
});

test('workspaces with unrecorded changes or files that only exist there are never parked', async () => {
  const p = project('keep');
  fs.writeFileSync(path.join(p.root, 'new.txt'), 'not recorded');
  assert.match(parkBlocker(p.ws) ?? '', /記録していない変更/);
  fs.rmSync(path.join(p.root, 'new.txt'));
  fs.mkdirSync(path.join(p.root, 'works'));
  fs.writeFileSync(path.join(p.root, 'works', 'page01.png'), 'generated');
  assert.match(parkBlocker(p.ws) ?? '', /作業場所にしか無いファイル.*works/);

  const hub = new Hub(new Db(':memory:'));
  const manager = new SessionManager(hub);
  hub.add(session({ id: 'k', project: { path: p.repo, name: 'repo' }, workspace: p.ws }));
  assert.deepEqual(await manager.parkIdleWorkspaces(Date.now() + 30 * 86_400_000, WORKTREE_ROOT), []);
  assert.ok(fs.existsSync(path.join(p.root, 'works', 'page01.png')));
});

test('a workspace something is still using is left completely untouched (not half-deleted)', { skip: process.platform !== 'win32' }, async () => {
  const p = project('busy');
  // エディタや開発サーバーの代わり: フォルダの中で動き続けるプロセス
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: p.root, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 500));
    const err = await parkWorktree(p.repo, p.ws);
    assert.match(err ?? '', /使っているので、片付けを見送りました/);
    assert.equal(fs.readFileSync(path.join(p.root, 'a.txt'), 'utf8'), 'one\n');
    assert.ok(fs.existsSync(path.join(p.root, '.git')));
  } finally {
    child.kill();
  }
});

test('an empty leftover folder (half-deleted earlier) is rebuilt in place', async () => {
  const p = project('leftover');
  await parkWorktree(p.repo, p.ws);
  fs.mkdirSync(p.root); // 中身だけ消えて空のフォルダが残った状態
  const hub = new Hub(new Db(':memory:'));
  const manager = new SessionManager(hub);
  hub.add(session({ id: 'l', project: { path: p.repo, name: 'repo' }, workspace: p.ws }));
  manager.ensureWorkspace('l');
  assert.equal(fs.readFileSync(path.join(p.root, 'a.txt'), 'utf8'), 'one\n');
});

test('restore says plainly when the branch is gone', async () => {
  const p = project('gone');
  await parkWorktree(p.repo, p.ws);
  p.run(p.repo, 'branch', '-D', 'tower/gone');
  assert.match(restoreWorktree(p.repo, p.ws) ?? '', /ブランチ tower\/gone が見つかりません/);
});

test('leftover folders no task uses are removed, but a live one with its own files is kept', async () => {
  const root = path.join(DATA, 'orphans');
  fs.mkdirSync(path.join(root, 'half-deleted', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'half-deleted', 'src', 'x.txt'), 'x');
  const used = path.join(root, 'in-use');
  fs.mkdirSync(used);
  const removed = await removeOrphanWorktrees([used], root);
  assert.deepEqual(removed, [path.join(root, 'half-deleted')]);
  assert.ok(fs.existsSync(used));

  // git の作業場所として生きていて、作業場所にしか無いファイルがあるものは残す
  const p = project('orphan-live');
  fs.mkdirSync(path.join(p.root, 'works'));
  fs.writeFileSync(path.join(p.root, 'works', 'p.png'), 'g');
  assert.deepEqual(await removeOrphanWorktrees([], WORKTREE_ROOT).then((r) => r.filter((d) => d === p.root)), []);
  assert.ok(fs.existsSync(p.root));
});

test('a long run does not push the instruction itself out of the loaded timeline', () => {
  const db = new Db(':memory:');
  db.appendTimeline({ id: 'u', sessionId: 's', ts: 1, kind: 'user', text: '指示' });
  for (let i = 0; i < 12; i++) db.appendTimeline({ id: `t${i}`, sessionId: 's', ts: 10 + i, kind: 'tool_use', text: `作業 ${i}` });
  const items = db.loadTimeline('s', 10);
  assert.equal(items.length, 11);
  assert.equal(items[0].id, 'u');
  assert.equal(items[items.length - 1].id, 't11');
  // 件数に収まっていれば何も足さない
  assert.equal(db.loadTimeline('s', 50).length, 13);
});

test('auto-commit leaves out big generated files (and says so), and records the rest', () => {
  const p = project('big');
  fs.writeFileSync(path.join(p.root, 'a.txt'), 'changed\n');
  const png = Buffer.alloc(2 * 1024 * 1024, 1);
  png[10] = 0;
  fs.writeFileSync(path.join(p.root, 'page.png'), png);
  fs.writeFileSync(path.join(p.root, 'small.png'), Buffer.from([0, 1, 2, 3]));
  const s = session({ id: '12345678-aaaa-bbbb-cccc-1234567890ab', project: { path: p.repo, name: 'repo' }, workspace: p.ws });
  const r = commitTaskWork(s, null);
  assert.equal(r.kind, 'committed');
  if (r.kind !== 'committed') return;
  assert.deepEqual(r.files.sort(), ['a.txt', 'small.png']);
  assert.match(r.largeNote ?? '', /page\.png/);
  // 大きなファイルは消さずに残っている（記録していないだけ）
  assert.ok(fs.existsSync(path.join(p.root, 'page.png')));
  assert.match(git(p.root, ['status', '--porcelain']).out, /page\.png/);

  // 大きなファイルしか無ければ、記録せずに理由を伝える
  const again = commitTaskWork(s, null);
  assert.equal(again.kind, 'skipped');
  assert.match(again.kind === 'skipped' ? again.message ?? '' : '', /page\.png/);
});
