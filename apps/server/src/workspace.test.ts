import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browseProjects } from './project-browser.ts';
import { collectHistory } from './diff.ts';
import { git } from './worktree.ts';
import { authorizationUrl } from './codex-login.ts';

test('project browser navigates nested projects, parent directories, and rejects invalid paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-browse-'));
  try {
    fs.mkdirSync(path.join(root, 'group', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
    assert.deepEqual(browseProjects(root).projects.map((p) => p.name), ['group']);
    const group = browseProjects(path.join(root, 'group'));
    assert.equal(group.parent, fs.realpathSync(root));
    assert.equal(group.projects[0].name, 'nested');
    assert.equal(browseProjects(group.projects[0].path).projects.length, 0);
    assert.throws(() => browseProjects('relative'));
    assert.throws(() => browseProjects(path.join(root, 'note.txt')));
    assert.throws(() => browseProjects(path.join(root, 'missing')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Git history returns actual branch and merge parent relationships', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-graph-'));
  const run = (...args: string[]) => { const result = git(root, args); assert.ok(result.ok, result.err); return result.out; };
  try {
    run('init', '-b', 'main'); run('config', 'user.name', 'Tower Test'); run('config', 'user.email', 'test@example.invalid');
    assert.deepEqual(collectHistory(root), []);
    run('commit', '--allow-empty', '-m', 'Initial');
    run('checkout', '-b', 'feature'); run('commit', '--allow-empty', '-m', 'Feature', '-m', 'Full message\nwith another line');
    const feature = run('rev-parse', 'HEAD');
    run('checkout', 'main'); run('commit', '--allow-empty', '-m', 'Main');
    const main = run('rev-parse', 'HEAD');
    run('merge', '--no-ff', 'feature', '-m', 'Merge feature');
    const history = collectHistory(root);
    assert.equal(history.length, 4);
    assert.deepEqual(history[0].parents, [main, feature]);
    assert.match(history[0].refs, /HEAD -> main/);
    assert.equal(history.find((c) => c.hash === feature)?.subject, 'Feature');
    assert.match(history.find((c) => c.hash === feature)!.message!, /Full message\nwith another line/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('login output exposes only an official authorization URL', () => {
  assert.equal(authorizationUrl('https://evil.example/oauth/authorize?secret=123'), undefined);
  assert.equal(authorizationUrl('https://auth.openai.com.evil.example/oauth/authorize'), undefined);
  assert.equal(authorizationUrl('https://auth.openai.com/token?token=secret'), undefined);
  assert.equal(authorizationUrl('Open:\nhttps://auth.openai.com/oauth/authorize?state=fixture\nprivate-token'), 'https://auth.openai.com/oauth/authorize?state=fixture');
});
