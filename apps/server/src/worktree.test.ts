import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Report, Session, Workspace } from '@tower/shared';
import type { AgentRunner } from './agents/types.ts';
import { Db } from './db.ts';
import { Hub } from './hub.ts';
import { SessionManager } from './manager.ts';
import { git, mergeWorktree } from './worktree.ts';

const LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

/** 元のプロジェクト（main に 1 コミット）と、そこから分けた作業場所を作る */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-merge-'));
  const repo = path.join(dir, 'repo');
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(repo);
  const run = (cwd: string, ...args: string[]) => {
    const r = git(cwd, args);
    assert.ok(r.ok, `${args.join(' ')}: ${r.err}`);
    return r.out;
  };
  run(repo, 'init', '-q', '-b', 'main');
  run(repo, 'config', 'user.name', 'Tower Test');
  run(repo, 'config', 'user.email', 'test@example.invalid');
  run(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), `${LINES.join('\n')}\n`);
  run(repo, 'add', '-A');
  run(repo, 'commit', '-q', '-m', 'init');
  const base = run(repo, 'rev-parse', 'HEAD');
  run(repo, 'worktree', 'add', '-q', '-b', 'tower/test', wt, 'HEAD');
  const ws: Workspace = { path: wt, root: wt, branch: 'tower/test', baseBranch: 'main', baseCommit: base, lastMerge: null };
  const read = (root: string) => fs.readFileSync(path.join(root, 'a.txt'), 'utf8').split('\n');
  /** line 行目（1 始まり）を書き換える */
  const edit = (root: string, line: number, text: string) => {
    const lines = read(root);
    lines[line - 1] = text;
    fs.writeFileSync(path.join(root, 'a.txt'), lines.join('\n'));
  };
  const status = (root: string) => git(root, ['status', '--porcelain']).out;
  return { repo, wt, ws, run, read, edit, status, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('unsaved changes in the original project are recorded first, then the copy is merged', () => {
  const t = setup();
  try {
    t.edit(t.wt, 1, 'copy');
    t.edit(t.repo, 10, 'original');
    const r = mergeWorktree(t.repo, t.ws, '直す');
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /保存していなかった 1 ファイルの変更を記録/);
    const lines = t.read(t.repo);
    assert.equal(lines[0], 'copy');
    assert.equal(lines[9], 'original');
    assert.equal(t.status(t.repo), '');
  } finally {
    t.cleanup();
  }
});

test('while a task is working directly in the original folder, its unsaved changes are left alone', () => {
  const t = setup();
  try {
    t.edit(t.wt, 1, 'copy');
    t.edit(t.repo, 10, 'original');
    const head = t.run(t.repo, 'rev-parse', 'HEAD');
    const r = mergeWorktree(t.repo, t.ws, '直す', { busyTasks: ['別のタスク'] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'busy');
    assert.match(r.message, /「別のタスク」/);
    assert.equal(t.run(t.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(t.read(t.repo)[9], 'original');
    assert.notEqual(t.status(t.repo), '');
  } finally {
    t.cleanup();
  }
});

test('a conflict leaves the original project clean, with its unsaved changes recorded', () => {
  const t = setup();
  try {
    t.edit(t.wt, 1, 'copy');
    t.edit(t.repo, 1, 'original');
    const r = mergeWorktree(t.repo, t.ws, '直す');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'conflict');
    assert.match(r.message, /記録しました/);
    assert.equal(t.status(t.repo), '');
    assert.equal(t.read(t.repo)[0], 'original');
    assert.equal(git(t.repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok, false);
  } finally {
    t.cleanup();
  }
});

test('conflict markers left in the copy are never merged', () => {
  const t = setup();
  try {
    t.edit(t.repo, 1, 'original');
    t.run(t.repo, 'commit', '-q', '-am', 'original');
    t.edit(t.wt, 1, 'copy');
    t.run(t.wt, 'commit', '-q', '-am', 'copy');
    assert.equal(git(t.wt, ['merge', 'main']).ok, false); // 合わせかけで止まる
    const head = t.run(t.repo, 'rev-parse', 'HEAD');
    const r = mergeWorktree(t.repo, t.ws, '直す');
    assert.equal(r.reason, 'unresolved');
    assert.notEqual(git(t.wt, ['ls-files', '-u']).out, '');
    assert.equal(t.run(t.repo, 'rev-parse', 'HEAD'), head);
  } finally {
    t.cleanup();
  }
});

function session(patch: Partial<Session>): Session {
  return {
    id: 'id',
    agent: 'claude',
    agentSessionId: 'agent-1',
    project: { path: 'C:\\proj', name: 'proj' },
    title: 't',
    prompt: 'p',
    model: null,
    permissionMode: 'acceptEdits',
    status: 'idle',
    activity: '報告しました',
    pending: null,
    pendingCount: 0,
    report: null,
    turns: 0,
    costUsd: 0,
    toolCalls: 0,
    changedFiles: [],
    createdAt: 1,
    updatedAt: 1,
    lastError: null,
    ...patch,
  };
}

const report = (generatedAt: number): Report => ({ request: 'r', outcome: 'done', summary: ['直した'], changedFiles: [], needsDecision: null, nextStep: null, raw: '', generatedAt });

/** 動いているエージェントの代わり。送られた指示だけ覚える */
function withManager(t: ReturnType<typeof setup>) {
  const hub = new Hub(new Db(':memory:'));
  const manager = new SessionManager(hub);
  hub.add(session({ id: 'm', title: '停止の扱いを直す', project: { path: t.repo, name: 'repo' }, workspace: t.ws, report: report(1) }));
  const sent: string[] = [];
  const runner = { start() {}, send(text: string) { sent.push(text); }, async stop() {}, resolvePermission: () => false, answerQuestion: () => false } as unknown as AgentRunner;
  (manager as unknown as { runners: Map<string, AgentRunner> }).runners.set('m', runner);
  return { hub, manager, sent };
}

test('a conflict is handed to the AI, and Tower merges again once its report comes in', () => {
  const t = setup();
  try {
    t.edit(t.wt, 1, 'copy');
    t.edit(t.repo, 1, 'original');
    t.run(t.repo, 'commit', '-q', '-am', 'original');
    const { hub, manager, sent } = withManager(t);
    const r = manager.merge('m');
    assert.equal(r.reason, 'conflict');
    assert.match(r.message, /AI に、元のプロジェクトの変更と合わせて直すよう頼みました/);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /git merge main/);
    assert.ok(hub.get('m')!.workspace!.mergeFix);

    // AI が元のプロジェクトの変更を取り込み、両方を残して直した
    assert.equal(git(t.wt, ['merge', 'main']).ok, false);
    fs.writeFileSync(path.join(t.wt, 'a.txt'), `${['copy + original', ...LINES.slice(1)].join('\n')}\n`);
    t.run(t.wt, 'add', '-A');
    t.run(t.wt, 'commit', '-q', '--no-edit');
    hub.update('m', { status: 'idle', report: report(Date.now() + 1) });

    const ws = hub.get('m')!.workspace!;
    assert.equal(ws.lastMerge?.ok, true, ws.lastMerge?.message);
    assert.equal(ws.mergeFix, null);
    assert.equal(t.read(t.repo)[0], 'copy + original');
    assert.equal(sent.length, 1); // 頼んだのは一度だけ
  } finally {
    t.cleanup();
  }
});

test('if the conflict is still there after the AI report, Tower hands it back instead of asking again', () => {
  const t = setup();
  try {
    t.edit(t.wt, 1, 'copy');
    t.edit(t.repo, 1, 'original');
    t.run(t.repo, 'commit', '-q', '-am', 'original');
    const { hub, manager, sent } = withManager(t);
    manager.merge('m');
    hub.update('m', { status: 'idle', report: report(Date.now() + 1) }); // 直さずに報告した
    const ws = hub.get('m')!.workspace!;
    assert.equal(ws.lastMerge?.ok, false);
    assert.match(ws.lastMerge!.message, /まだ合流できていません/);
    assert.equal(ws.mergeFix, null);
    assert.equal(sent.length, 1);
  } finally {
    t.cleanup();
  }
});

test('the button names the task that is working directly in the original folder', () => {
  const t = setup();
  try {
    t.edit(t.wt, 1, 'copy');
    t.edit(t.repo, 10, 'original');
    const { hub, manager, sent } = withManager(t);
    hub.add(session({ id: 'd', title: '元のフォルダで作業中', project: { path: t.repo, name: 'repo' }, status: 'running' }));
    const r = manager.merge('m');
    assert.equal(r.reason, 'busy');
    assert.match(r.message, /元のフォルダで作業中/);
    assert.equal(sent.length, 0);
    assert.notEqual(t.status(t.repo), '');
  } finally {
    t.cleanup();
  }
});
