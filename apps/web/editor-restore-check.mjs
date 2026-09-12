// Run with Vite on 127.0.0.1:5179: `node apps/web/editor-restore-check.mjs`. All APIs are mocked; nothing real is read or written.
// Checks that the editor comes back after a reload (= app restart / deploy): open tabs, split, the free layout,
// unsaved drafts (restored as-is when the file is unchanged, offered when it changed), and tabs of deleted tasks are closed.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

// Monaco draws spaces as no-break spaces
const nb = (s) => s.replace(/ /g, ' ');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.error(e.stack); });
  const session = { id: 'test', project: { name: 'editor', path: 'C:/projects/editor' }, title: 'Restore check', prompt: 'Check', agent: 'claude', status: 'idle', permissionMode: 'default', activity: 'Ready', changedFiles: [], createdAt: Date.now(), updatedAt: Date.now(), turns: 0, toolCalls: 0, costUsd: 0, pending: null, report: null };
  let sessions = [session];
  const contents = { 'note.txt': 'first line\nsecond line\n', 'README.md': '# 見出し\n\n本文\n' };
  await page.routeWebSocket('**/ws', (ws) => ws.send(JSON.stringify({ type: 'snapshot', sessions })));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname, q = url.searchParams;
    let data = {};
    if (p.endsWith('/timeline')) data = [];
    else if (p.endsWith('/tree')) data = { path: q.get('path'), entries: q.get('path') ? [] : [{ name: 'README.md', path: 'README.md', kind: 'file' }, { name: 'note.txt', path: 'note.txt', kind: 'file' }], skipped: [], truncated: 0 };
    else if (p.endsWith('/files')) data = { files: Object.keys(contents), truncated: false };
    else if (p.endsWith('/line-marks')) data = { against: '最後の記録（コミット）', marks: [] };
    else if (p.endsWith('/file')) data = { path: q.get('path'), content: contents[q.get('path')] ?? '', size: 1 };
    else if (p === '/api/agents') data = { claude: { available: true }, codex: { available: true } };
    else if (p === '/api/settings') data = { settings: {}, file: 'C:/tower/config.json', version: 'test', needsRestart: [] };
    else if (p === '/api/bridge') data = { enabled: false, permissions: false };
    else if (p === '/api/usage') { const z = { count: 0, input: 0, cacheRead: 0, output: 0, cost: 0 }; data = { today: z, week: z, all: z, projectsToday: [] }; }
    else if (p === '/api/feedback') data = { notes: [], file: 'C:/feedback.md' };
    return route.fulfill({ json: data });
  });
  await page.goto(process.env.TOWER_TEST_URL ?? 'http://127.0.0.1:5179');
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('tower.editor.')) localStorage.removeItem(k); });
  await page.reload();
  await page.getByRole('button').filter({ hasText: 'Restore check' }).click();
  const tree = page.locator('aside').first();
  await tree.getByRole('button', { name: 'README.md', exact: true }).click();
  await tree.getByRole('button', { name: 'note.txt', exact: true }).click();
  const note = page.getByRole('tabpanel', { name: 'note.txt', exact: true });
  await note.locator('.monaco-editor').waitFor();

  // 1) Split, type without saving, reload
  await page.getByRole('button', { name: '左右に分割' }).click();
  await note.locator('.view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('draft-XYZ');
  await note.getByText('● 未保存').waitFor();
  await page.waitForTimeout(600);
  await page.reload();
  const noteAgain = page.getByRole('tabpanel', { name: 'note.txt', exact: true });
  await noteAgain.locator('.monaco-editor').waitFor();
  assert.equal(await page.getByRole('tab', { name: /README\.md/ }).count(), 1, 'README.md のタブが戻る');
  assert.equal(await page.getByRole('tab', { name: /note\.txt/ }).count(), 1, 'note.txt のタブが戻る');
  assert.equal(await page.getByRole('button', { name: '左右に分割' }).getAttribute('aria-pressed'), 'true', '左右の分割が戻る');
  await noteAgain.getByText(/前回保存していなかった変更.*を戻しました/).waitFor();
  await noteAgain.getByText('● 未保存').waitFor();
  assert.match(await noteAgain.locator('.view-lines').innerText().then(nb), /draft-XYZ/, '書きかけの中身が戻る');
  await page.screenshot({ path: 'docs/screenshots/editor-restore.png' });

  // 2) The file changed on disk since the draft: not restored silently, offered instead
  contents['note.txt'] = 'someone else changed this\n';
  await page.reload();
  const changed = page.getByRole('tabpanel', { name: 'note.txt', exact: true });
  await changed.getByText(/その後ファイルが変わったので、自動では戻していません/).waitFor();
  assert.match(await changed.locator('.view-lines').innerText().then(nb), /someone else changed this/);
  assert.equal(await changed.getByText('● 未保存').count(), 0, '決めるまでは未保存にしない');
  await changed.getByRole('button', { name: '書きかけを戻す' }).click();
  await changed.getByText('● 未保存').waitFor();
  assert.match(await changed.locator('.view-lines').innerText().then(nb), /draft-XYZ/);

  // 3) Discard: the draft is gone after the next reload
  await page.waitForTimeout(600);
  await page.reload();
  const again = page.getByRole('tabpanel', { name: 'note.txt', exact: true });
  await again.getByRole('button', { name: '捨てる' }).click();
  await page.reload();
  const clean = page.getByRole('tabpanel', { name: 'note.txt', exact: true });
  await clean.locator('.monaco-editor').waitFor();
  assert.equal(await clean.getByText(/前回保存していなかった変更/).count(), 0, '捨てた書きかけは出ない');

  // 4) Free layout is remembered
  await page.getByRole('button', { name: '自由に配置' }).click();
  await page.waitForTimeout(600);
  await page.reload();
  await page.getByRole('region', { name: '自由配置のデスク' }).or(page.locator('[aria-label="自由配置のデスク"]')).first().waitFor();
  assert.equal(await page.getByRole('button', { name: '自由に配置' }).getAttribute('aria-pressed'), 'true', '自由配置が戻る');

  // 5) Tabs of a task that no longer exists are closed
  sessions = [];
  await page.reload();
  await page.waitForTimeout(800);
  assert.equal(await page.getByRole('tabpanel', { name: 'note.txt', exact: true }).count(), 0, '消えたタスクのタブは閉じる');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tower.editor.draft:')).length), 0, '書きかけも消える');

  assert.deepEqual(errors, []);
  console.log('editor restore check: ok');
} finally {
  await browser.close();
}
