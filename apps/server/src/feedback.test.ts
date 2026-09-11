import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listDir, readFileContent, resolveImage, writeFileContent } from './files.ts';
import { validateSettings } from './config.ts';
import { ClaudeRunner } from './agents/claude.ts';
import type { Session } from '@tower/shared';
import type { Hub } from './hub.ts';

test('file explorer and images stay inside the project including junctions', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-feedback-'));
  try {
    const root = path.join(temp, 'project');
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(root); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    fs.writeFileSync(path.join(root, 'note.txt'), 'a\r\nb\r\n');
    fs.writeFileSync(path.join(root, 'image.PNG'), 'image');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    const tree = listDir(root, '');
    assert(tree.skipped.includes('node_modules'));
    assert.equal(tree.entries[0].name, 'src');
    assert.equal(resolveImage(root, 'image.PNG').mime, 'image/png');
    assert.throws(() => resolveImage(root, 'note.txt'));
    assert.throws(() => readFileContent(root, '../outside/secret.txt'));
    assert.throws(() => readFileContent(root, 'link/secret.txt'));
    assert.throws(() => listDir(root, 'link'));
    assert.throws(() => writeFileContent(root, 'link/new.txt', 'bad'));
    assert(!fs.existsSync(path.join(outside, 'new.txt')));
    writeFileContent(root, 'note.txt', 'c\nd\n');
    assert.equal(readFileContent(root, 'note.txt').content, 'c\r\nd\r\n');
    writeFileContent(root, 'new/nested.txt', 'new');
    assert.equal(readFileContent(root, 'new/nested.txt').content, 'new');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('settings reject invalid ports, durations and relative feedback paths', () => {
  assert.throws(() => validateSettings({ port: 0 }));
  assert.throws(() => validateSettings({ bridgeWaitSeconds: 601 }));
  assert.throws(() => validateSettings({ feedbackFile: 'relative.md' }));
  assert.deepEqual(validateSettings({ port: 4801, externalKeepHours: 0 }), { port: 4801, externalKeepHours: 0 });
});

test('permission changes persist only after SDK success, and preserve questions', async () => {
  let state = { id: 'test', permissionMode: 'default' } as Session;
  const hub = { get: () => state, update: (_: string, patch: Partial<Session>) => { state = { ...state, ...patch }; }, timeline: () => {} };
  const runner = new ClaudeRunner(state, hub as unknown as Hub);
  // Fake SDK boundary: never start an agent or execute a tool.
  const internal = runner as unknown as { q: { setPermissionMode: (mode: string) => Promise<void> }; queue: { id: string; kind: string }[]; timeline: () => void };
  internal.timeline = () => {};
  internal.q = { setPermissionMode: async () => { throw new Error('SDK rejected'); } };
  await assert.rejects(runner.setPermissionMode('auto'), /SDK rejected/);
  assert.equal(state.permissionMode, 'default');
  const approved: string[] = [];
  internal.q = { setPermissionMode: async () => {} };
  internal.queue = [{ id: 'tool', kind: 'permission' }, { id: 'question', kind: 'question' }];
  runner.resolvePermission = (id) => { approved.push(id); return true; };
  await runner.setPermissionMode('auto');
  assert.deepEqual(approved, []);
  await runner.setPermissionMode('bypassPermissions');
  assert.equal(state.permissionMode, 'bypassPermissions');
  assert.deepEqual(approved, ['tool']);
});
