import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { runVerify } from './verify.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-verify-cancel-'));
  const pids = () => ['parent.pid', 'child.pid'].flatMap((file) => {
    try { return [Number(fs.readFileSync(path.join(dir, file), 'utf8'))]; } catch { return []; }
  });
  t.after(() => {
    // Only PIDs written by this fixture are eligible for cleanup if an assertion fails.
    for (const pid of pids()) {
      if (!alive(pid)) continue;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'worker.cjs'), `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    fs.writeFileSync('parent.pid', String(process.pid));
    spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('child.pid', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
    console.log('# pass 1');
    console.log('# fail 0');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `);
  return { dir, command: `"${process.execPath}" worker.cjs`, pids };
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await delay(20);
  assert.ok(check(), message);
}

test('already aborted verification never launches the command', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const result = await runVerify(f.dir, f.command, 10_000, controller.signal);
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.deepEqual(f.pids(), []);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort kills the actual command and its child, without treating partial passing output as success', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const pending = runVerify(f.dir, f.command, 15_000, controller.signal);
  await until(() => f.pids().length === 2, 'both fixture processes started');
  const pids = f.pids();
  controller.abort();
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.summary, '中止');
  await until(() => pids.every((pid) => !alive(pid)), 'command and child both terminated');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('timeout kills the process tree and wins a later abort race', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const pending = runVerify(f.dir, f.command, 3000, controller.signal);
  await until(() => f.pids().length === 2, 'both fixture processes started before timeout');
  const pids = f.pids();
  const abortTimer = setTimeout(() => controller.abort(), 3050);
  t.after(() => clearTimeout(abortTimer));
  const result = await pending;
  controller.abort();
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.summary, 'タイムアウト');
  await until(() => pids.every((pid) => !alive(pid)), 'timed-out command and child both terminated');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('normal completion is successful and removes the abort listener', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'success.cjs'), "console.log('# pass 1'); console.log('# fail 0');");
  const controller = new AbortController();
  const result = await runVerify(f.dir, `"${process.execPath}" success.cjs`, 10_000, controller.signal);
  controller.abort();
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.timedOut, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
