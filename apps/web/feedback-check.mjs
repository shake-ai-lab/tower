// Run with Vite on 127.0.0.1:5179. All application APIs are mocked; no real task or settings are modified.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.error(e.stack); });
  const session = { id: 'test', project: { name: 'editor', path: 'C:/projects/editor' }, title: 'Feedback UI check', prompt: 'Check the workspace', agent: 'claude', status: 'idle', permissionMode: 'default', activity: 'Ready', changedFiles: [], createdAt: Date.now(), updatedAt: Date.now(), turns: 0, toolCalls: 0, costUsd: 0, pending: null, report: null };
  let settings = { host: '127.0.0.1', port: 4800, projectRoots: ['C:/projects'], autoVerify: true, reformatReports: true, bridgeWaitSeconds: 90, externalKeepHours: 24, feedbackFile: 'C:/projects/editor/docs/feedback.md' };
  let permissionWrites = 0;
  let settingsWrites = 0;
  let loggedIn = false;
  let loginStarted = false;
  let loginPolls = 0;
  const sentMessages = [];
  const duplicate = { ...session, id: 'duplicate', title: 'A very long task title '.repeat(10), project: { name: 'editor', path: 'c:\\Projects\\EDITOR\\' }, origin: 'external', externalHint: 'External editor integration with a long label', agent: 'codex', activity: 'Long activity '.repeat(20), turns: 1234, toolCalls: 5678, costUsd: 123.45 };
  const separate = { ...session, id: 'separate', title: 'A separate project with the same name', project: { name: 'editor', path: 'C:/other/editor' } };
  await page.routeWebSocket('**/ws', (ws) => ws.send(JSON.stringify({ type: 'snapshot', sessions: [session, duplicate, separate] })));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    let data = {};
    if (p.endsWith('/timeline')) data = [];
    else if (p.endsWith('/message')) { sentMessages.push({ id: p.split('/')[3], text: route.request().postDataJSON().text }); data = { ok: true }; }
    else if (p.endsWith('/tree')) data = { path: url.searchParams.get('path'), entries: url.searchParams.get('path') === 'src' ? [{ name: 'App.tsx', path: 'src/App.tsx', kind: 'file' }] : [{ name: 'src', path: 'src', kind: 'dir' }, { name: 'note.txt', path: 'note.txt', kind: 'file' }, { name: 'image.svg', path: 'image.svg', kind: 'file' }], skipped: [], truncated: 0 };
    else if (p.endsWith('/raw')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#38bdf8"/></svg>' });
    else if (p.endsWith('/file')) data = { path: 'note.txt', content: 'Hello workspace', size: 15 };
    else if (p.endsWith('/changes')) data = { isGit: true, branch: 'feature/feedback', files: [{ path: 'src/App.tsx', status: 'M', diff: '@@ -1 +1 @@\n-old\n+new' }, { path: 'docs/guide.md', status: 'A', diff: '+guide' }], history: [{ hash: 'ccccccc', parents: ['aaaaaaa', 'bbbbbbb'], subject: 'Merge workspace improvements', refs: 'HEAD -> feature/feedback', author: 'Tower' }, { hash: 'aaaaaaa', parents: ['ddddddd'], subject: 'Improve file navigation', refs: 'main', author: 'Tower' }, { hash: 'bbbbbbb', parents: ['ddddddd'], subject: 'Add login entry', refs: 'login', author: 'Tower' }, { hash: 'ddddddd', parents: [], subject: 'Initial workspace', refs: '', author: 'Tower' }] };
    else if (p === '/api/agents') data = { claude: { available: true }, codex: { available: loggedIn, reason: 'Login required' } };
    else if (p === '/api/agents/codex/login') {
      if (route.request().method() === 'POST') loginStarted = true;
      if (loginStarted && ++loginPolls > 2) loggedIn = true;
      data = { status: loggedIn ? 'success' : loginStarted ? 'waiting' : 'idle', ...(loginStarted && !loggedIn ? { url: 'https://auth.openai.com/oauth/authorize?state=fixture' } : {}) };
    }
    else if (p === '/api/projects') data = [{ name: 'projects', path: 'C:/projects', hasGit: false, modifiedAt: 0 }];
    else if (p === '/api/projects/browse') data = { path: 'C:/projects', parent: 'C:/', projects: [{ name: 'editor', path: 'C:/projects/editor', hasGit: true, modifiedAt: 0 }] };
    else if (p.endsWith('/permission-mode')) { session.permissionMode = route.request().postDataJSON().mode; permissionWrites++; data = session; }
    else if (p === '/api/settings') {
      if (route.request().method() === 'PUT') { settings = route.request().postDataJSON(); settingsWrites++; }
      data = { settings, file: 'C:/tower/config.json', version: 'test', needsRestart: [] };
    }
    else if (p === '/api/bridge') data = { enabled: false, permissions: false };
    else if (p === '/api/usage') { const z = { count: 0, input: 0, cacheRead: 0, output: 0, cost: 0 }; data = { today: z, week: z, all: z, projectsToday: [] }; }
    else if (p === '/api/config') data = {};
    else if (p === '/api/feedback') data = { notes: [], file: 'C:/feedback.md' };
    return route.fulfill({ json: data });
  });
  await page.goto('http://127.0.0.1:5179');
  const projectFilter = page.getByLabel('プロジェクトで絞り込み');
  assert.equal(await projectFilter.locator('option').count(), 3);
  await projectFilter.selectOption('c:/projects/editor');
  assert.equal(await page.locator('main section').count(), 1);
  assert.equal(await page.locator('main section button').count(), 2);
  await projectFilter.selectOption('');
  await page.getByRole('button').filter({ hasText: 'Feedback UI check' }).click();
  await page.getByRole('button', { name: 'note.txt', exact: false }).waitFor();
  await page.getByRole('button', { name: 'src', exact: false }).click();
  await page.getByRole('button', { name: 'App.tsx', exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'src', exact: false }).getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: 'docs/screenshots/workspace-files.png' });
  await page.getByRole('button', { name: 'image.svg', exact: false }).click();
  await page.getByAltText('image.svg').waitFor();
  await page.waitForFunction(() => document.querySelector('img[alt="image.svg"]')?.naturalWidth === 400);
  await page.getByRole('tabpanel').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: 'note.txt', exact: false }).click();
  await page.getByRole('tabpanel').locator('.monaco-editor').waitFor();
  await page.getByRole('tabpanel').getByRole('button', { name: '保存（Ctrl+S）' }).waitFor();
  await page.getByRole('tabpanel').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByText('ブランチ: feature/feedback').waitFor();
  assert.equal(await page.getByLabel('コミットグラフ').locator('circle').count(), 4);
  assert.equal(await page.getByLabel('コミットグラフ').locator('path').count(), 4);
  await page.getByLabel('コミットグラフ').getByRole('button').first().click();
  await page.getByLabel('コミット詳細', { exact: true }).waitFor();
  await page.screenshot({ path: 'docs/screenshots/workspace-git.png' });
  await page.getByLabel('タスクの許可方針').selectOption('auto');
  await page.waitForFunction(() => document.querySelector('select[aria-label="タスクの許可方針"]')?.value === 'auto');
  assert.equal(permissionWrites, 1);
  const separator = page.getByRole('separator', { name: '左パネルの幅' });
  await separator.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('[aria-label="左パネルの幅"]')?.getAttribute('aria-valuenow') === '340');
  assert.equal(await separator.getAttribute('aria-valuenow'), '340');
  const handle = await separator.boundingBox();
  await page.mouse.move(handle.x + 2, handle.y + 100); await page.mouse.down();
  await page.mouse.move(handle.x + 42, handle.y + 100); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[aria-label="左パネルの幅"]')?.getAttribute('aria-valuenow') === '380');
  assert.equal(await separator.getAttribute('aria-valuenow'), '380');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('button', { name: 'Codexにログイン', exact: true }).click();
  await page.getByLabel('Codexアカウント').getByText('ログイン済み', { exact: true }).waitFor();
  assert.ok(loginStarted);
  await page.getByLabel('外部タスクの保持時間', { exact: false }).fill('48');
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await page.getByText('保存しました', { exact: true }).waitFor();
  assert.equal(settingsWrites, 1); assert.equal(settings.externalKeepHours, 48);
  await page.getByRole('button', { name: 'パネル幅を元に戻す' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="左パネルの幅"]')?.getAttribute('aria-valuenow') === '320');
  assert.equal(await separator.getAttribute('aria-valuenow'), '320');
  await page.screenshot({ path: 'docs/screenshots/feedback-desktop.png' });
  await page.getByRole('button', { name: '＋ 新しいタスク', exact: false }).click();
  const newTask = page.getByRole('dialog', { name: '新しいタスク', exact: true });
  await newTask.getByRole('button', { name: 'projects のサブフォルダを開く' }).click();
  await newTask.getByRole('button', { name: 'editor C:/projects/editor', exact: true }).click();
  assert.equal(await newTask.getByLabel('選択した作業フォルダ').inputValue(), 'C:/projects/editor');
  await page.screenshot({ path: 'docs/screenshots/workspace-projects.png' });
  await newTask.getByRole('button', { name: '閉じる (Esc)' }).click();
  await page.getByRole('button', { name: 'ファイル', exact: true }).click();
  const detailHandle = page.getByRole('separator', { name: 'タスク詳細の幅' });
  for (const width of [1920, 1600, 1280, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [handle, offset] of [[separator, 1500], [detailHandle, -1500], [separator, -1500], [detailHandle, 1500]]) {
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + 2, box.y + 100); await page.mouse.down();
      await page.mouse.move(box.x + offset, box.y + 100); await page.mouse.up();
      await page.waitForTimeout(60);
      const geometry = await page.locator('main').evaluate((el) => ({ width: el.getBoundingClientRect().width, overflow: el.scrollWidth - el.clientWidth }));
      assert.ok(geometry.width >= 319, JSON.stringify({ width, geometry }));
      assert.ok(geometry.overflow <= 1, JSON.stringify({ width, geometry }));
      assert.ok(await page.locator('main section button').evaluateAll((cards) => cards.every((el) => el.scrollWidth <= el.clientWidth + 1)));
    }
  }
  await page.screenshot({ path: 'docs/screenshots/workspace-resized.png' });
  for (const width of [1000, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await detailHandle.count(), 0);
    assert.ok(await page.getByRole('button', { name: 'ファイル・Git・設定を見る' }).isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'ファイル・Git・設定を見る' }).click();
  await page.getByRole('button', { name: 'ファイル', exact: true }).click();
  await page.getByRole('button', { name: 'image.svg', exact: false }).click();
  await page.getByAltText('image.svg').waitFor();
  await page.screenshot({ path: 'docs/screenshots/feedback-mobile.png' });
  await page.getByRole('tabpanel').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.setViewportSize({ width: 1600, height: 1000 });
  const views = page.getByRole('navigation', { name: '表示パターン' });
  await views.getByRole('button', { name: 'コンパクト', exact: true }).click();
  assert.equal(await page.locator('main section button').count(), 3);
  await views.getByRole('button', { name: '集中', exact: true }).click();
  await page.getByLabel('集中するタスク').selectOption('duplicate');
  assert.equal(await page.getByLabel('集中ビュー').getByLabel('タスク詳細', { exact: true }).count(), 1);
  await views.getByRole('button', { name: '4分割', exact: true }).click();
  await page.getByLabel('パネル4のタスク').selectOption('test');
  assert.equal(await page.getByLabel('4分割ビュー').getByLabel('タスク詳細', { exact: true }).count(), 4);
  assert.equal(await page.getByRole('separator', { name: 'タスク詳細の幅' }).count(), 0);
  await page.getByLabel('パネル2のタスク').selectOption('separate');
  await page.getByLabel('4分割ビュー').getByText('01', { exact: true }).click();
  assert.match(await page.locator('.session-pane').first().getAttribute('class'), /border-sky-400/);
  assert.doesNotMatch(await page.locator('.session-pane').nth(1).getAttribute('class'), /border-sky-400/);
  assert.equal(await page.getByLabel('パネル1のタスク').inputValue(), 'test');
  assert.equal(await page.getByLabel('パネル2のタスク').inputValue(), 'separate');
  const secondPane = page.getByLabel('4分割ビュー').getByLabel('タスク詳細', { exact: true }).nth(1);
  await secondPane.getByRole('textbox').fill('Only send this to the second pane');
  await secondPane.getByRole('button', { name: '送信', exact: true }).click();
  assert.deepEqual(sentMessages, [{ id: 'separate', text: 'Only send this to the second pane' }]);
  await page.screenshot({ path: 'docs/screenshots/workspace-quad.png' });
  await page.reload();
  await page.getByLabel('4分割ビュー').waitFor();
  assert.equal(await page.getByLabel('パネル2のタスク').inputValue(), 'separate');
  assert.equal(await page.getByLabel('パネル4のタスク').inputValue(), 'test');
  assert.equal(await views.getByRole('button', { name: '4分割', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'セッション', exact: false }).last().click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS: nested folders, images/text, Git merge graph, mocked Codex login completion, nested project selection, permission change, resize, settings, mobile access; no page errors');
} finally { await browser.close(); }
