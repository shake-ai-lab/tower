// Isolated real HTTP/SQLite check. No model is invoked and no user data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-permission-api-'));
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ projectRoots: [], autoResume: false, autoCommit: false, autoVerify: false, reformatReports: false, externalKeepHours: 0 }));
const session = { id: 'api-permissions', agent: 'codex', origin: 'tower', agentSessionId: 'fixture', project: { path: dir, name: 'fixture' }, title: 'fixture', prompt: 'fixture', model: null, permissionMode: 'default', status: 'stopped', activity: '', pending: null, report: null, turns: 0, costUsd: 0, toolCalls: 0, changedFiles: [], createdAt: Date.now(), updatedAt: Date.now(), lastError: null };
const db = new DatabaseSync(path.join(dir, 'tower.db'));
db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)');
db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(session.id, JSON.stringify(session), session.updatedAt);
db.close();
let child;
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], { cwd: root, env: { ...process.env, TOWER_DATA_DIR: dir, TOWER_PORT: String(port), TOWER_HOST: '127.0.0.1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 15000);
    let log = '';
    child.stdout.on('data', (data) => { log += data; if (log.includes('[tower] http://')) { clearTimeout(timer); resolve(); } });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}
async function request(endpoint, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
try {
  await start();
  assert.equal((await request('/api/settings')).body.settings.codexPermissionMode, 'acceptEdits');
  assert.equal((await request('/api/settings', 'PUT', { codexPermissionMode: 'auto' })).status, 200);
  const changed = await request(`/api/sessions/${session.id}/permission-mode`, 'PUT', { mode: 'acceptEdits' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.permissionMode, 'acceptEdits');
  assert.equal((await request('/api/settings', 'PUT', { codexPermissionMode: 'invalid' })).status, 400);
  await stop();
  await start();
  assert.equal((await request('/api/settings')).body.settings.codexPermissionMode, 'auto');
  const sessions = (await request('/api/sessions')).body;
  assert.equal(sessions.find((s) => s.id === session.id).permissionMode, 'acceptEdits');
  fs.writeFileSync(new URL('api-result.json', import.meta.url), JSON.stringify({ passed: true, defaultAfterRestart: 'auto', taskAfterRestart: 'acceptEdits', permissionUpdateStatus: changed.status }, null, 2));
  console.log('PASS: real settings API, Codex task permission API, invalid-value rejection, persistence across server restart');
} finally {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
