// Run against a Vite dev server. Every API/WS request is replaced with test data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = process.argv[2] || 'http://127.0.0.1:5186';
const out = new URL('./', import.meta.url);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let settings = { codexPermissionMode: 'default', projectRoots: ['C:/fixture'], host: '127.0.0.1', port: 4800, autoVerify: false, reformatReports: false, autoResume: false, autoCommit: false, externalKeepHours: 24, bridgeWaitSeconds: 90, feedbackFile: 'C:/fixture/feedback.md' };
let session = { id: 'codex-fixture', agent: 'codex', agentSessionId: 'thread', project: { name: 'Codex権限の検証', path: 'C:/fixture' }, title: '権限の検証タスク', prompt: '検証', model: null, permissionMode: 'default', status: 'running', activity: '検証用の実行中タスク', pending: null, report: null, turns: 0, costUsd: 0, toolCalls: 0, changedFiles: [], createdAt: Date.now(), updatedAt: Date.now(), lastError: null };
let settingsFail = false, settingsDelay = 0;
const created = [], updates = [], unexpected = [];
await context.routeWebSocket('**/ws', (ws) => ws.send(JSON.stringify({ type: 'snapshot', sessions: [session] })));
await context.route('**/api/**', async (route) => {
  const req = route.request(), p = new URL(req.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, json: body });
  if (p === '/api/settings') {
    if (req.method() === 'PUT') settings = { ...settings, ...req.postDataJSON() };
    if (settingsDelay) await new Promise((r) => setTimeout(r, settingsDelay));
    if (settingsFail) return json({ error: '検証用の読込エラー' }, 503);
    return json({ file: 'fixture:config.json', version: 'fixture', needsRestart: [], settings });
  }
  if (p === '/api/agents') return json({ claude: { available: true }, codex: { available: true } });
  if (p === '/api/agents/codex/login') return json({ status: 'idle' });
  if (p === '/api/projects') return json([{ ...session.project, hasGit: false, modifiedAt: 1 }]);
  if (p === '/api/sessions') {
    if (req.method() === 'POST') { created.push(req.postDataJSON()); session = { ...session, ...req.postDataJSON() }; return json(session); }
    return json([session]);
  }
  if (p.endsWith('/permission-mode')) { updates.push(req.postDataJSON()); session = { ...session, permissionMode: req.postDataJSON().mode }; return json(session); }
  if (p === '/api/config') return json({ externalKeepHours: 24 });
  if (p === '/api/usage') { const empty = { count: 0, input: 0, cacheRead: 0, output: 0, cost: 0 }; return json({ today: empty, week: empty, all: empty, projectsToday: [] }); }
  if (p === '/api/bridge') return json({ installed: false, permissions: false });
  if (p === '/api/feedback') return json({ file: 'fixture:feedback', notes: [] });
  if (p.endsWith('/timeline')) return json([]);
  if (p.endsWith('/tree')) return json({ path: '', entries: [], skipped: [], truncated: 0 });
  if (p.endsWith('/files')) return json({ files: [], truncated: false });
  unexpected.push(`${req.method()} ${p}`);
  return json({ error: '検証対象外' }, 501);
});
try {
  await page.goto(origin);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const defaults = page.getByLabel('Codexの既定の権限', { exact: true });
  await defaults.selectOption('auto');
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await page.getByText('保存しました', { exact: true }).waitFor();
  assert.equal(settings.codexPermissionMode, 'auto');
  await page.getByRole('region', { name: 'Codexアカウント' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL('settings.png', out).pathname.replace(/^\/(.:)/, '$1'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  assert.equal(await defaults.inputValue(), 'auto');

  await page.getByRole('button', { name: /＋ 新しいタスク/ }).click();
  const dialog = page.getByRole('dialog', { name: '新しいタスク', exact: true });
  await dialog.getByRole('button', { name: 'Codex (OpenAI)', exact: true }).click();
  const permission = dialog.getByLabel('許可', { exact: true });
  await page.waitForFunction(() => [...document.querySelectorAll('select')].some((s) => s.value === 'auto'));
  assert.equal(await permission.inputValue(), 'auto');
  await permission.selectOption('bypassPermissions');
  await dialog.getByRole('button', { name: 'Claude Code', exact: true }).click();
  assert.equal(await permission.inputValue(), 'acceptEdits');
  await dialog.getByRole('button', { name: 'Codex (OpenAI)', exact: true }).click();
  assert.equal(await permission.inputValue(), 'bypassPermissions');
  await dialog.locator('textarea').fill('権限を選んで起動する検証');
  await page.screenshot({ path: new URL('new-task.png', out).pathname.replace(/^\/(.:)/, '$1'), fullPage: true });
  await dialog.getByRole('button', { name: '起動', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(created.at(-1).permissionMode, 'bypassPermissions');
  const taskPermission = page.getByLabel('タスクの許可方針', { exact: true });
  await taskPermission.selectOption('default');
  await page.waitForFunction(() => document.querySelector('select[aria-label="タスクの許可方針"]')?.disabled === false);
  assert.equal(updates.at(-1).mode, 'default');
  await page.getByText(/現在の応答が終わった後の新しい指示から/).waitFor();
  await page.screenshot({ path: new URL('active-task.png', out).pathname.replace(/^\/(.:)/, '$1'), fullPage: true });

  settingsFail = true;
  await page.getByRole('button', { name: /＋ 新しいタスク/ }).click();
  await dialog.getByRole('alert').waitFor();
  await dialog.locator('textarea').fill('読み込み失敗時は起動しない');
  assert.equal(await dialog.getByRole('button', { name: '起動', exact: true }).isDisabled(), true);
  settingsFail = false; settingsDelay = 1200;
  await dialog.getByRole('button', { name: '権限設定を再読み込み' }).click();
  await permission.selectOption('default');
  await dialog.getByRole('status').waitFor({ state: 'hidden' });
  assert.equal(await permission.inputValue(), 'default', '遅い設定応答で手動選択を上書きしない');
  await dialog.getByRole('button', { name: '起動', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(created.at(-1).permissionMode, 'default');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await fs.writeFile(new URL('result.json', out), JSON.stringify({ passed: true, settings: settings.codexPermissionMode, created: created.map((c) => c.permissionMode), updates, errors, unexpected }, null, 2));
  console.log('PASS: settings persistence, new task defaults, agent isolation, active task change, error recovery, slow response/manual selection');
} catch (e) {
  await page.screenshot({ path: new URL('failure.png', out).pathname.replace(/^\/(.:)/, '$1'), fullPage: true });
  console.error(await page.locator('body').innerText());
  throw e;
} finally { await browser.close(); }
