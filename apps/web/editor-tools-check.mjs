// Run with Vite on 127.0.0.1:5179: `node apps/web/editor-tools-check.mjs`. All APIs are mocked; nothing real is read or written.
// Checks the editor tools: open by name (Ctrl+P), project-wide search (Ctrl+Shift+F), changed-line marks,
// Japanese editor menus, and the readable Markdown view (sanitized, links open project files).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.error(e.stack); });
  const session = { id: 'test', project: { name: 'editor', path: 'C:/projects/editor' }, title: 'Editor tools check', prompt: 'Check', agent: 'claude', status: 'idle', permissionMode: 'default', activity: 'Ready', changedFiles: [], createdAt: Date.now(), updatedAt: Date.now(), turns: 0, toolCalls: 0, costUsd: 0, pending: null, report: null };
  const app = Array.from({ length: 40 }, (_, i) => (i === 2 ? 'const title = 1;' : `line ${i + 1}`)).join('\n');
  const contents = {
    'README.md': '# 見出し\n\n| 列A | 列B |\n|---|---|\n| 1 | 2 |\n\n- [x] 済み\n- [ ] まだ\n\n[案内](docs/guide.md) と [外のページ](https://example.com)\n\n<script>window.__pwned = 1</script>\n<img src="x" onerror="window.__pwned = 2">\n\n![画面](docs/img/shot.png)\n',
    'docs/guide.md': '# 案内のページ\n\n本文です。',
    'src/App.tsx': app,
    'note.txt': 'a\nb\nc\n',
  };
  const all = ['README.md', 'docs/guide.md', 'docs/img/shot.png', 'note.txt', 'src/App.tsx', 'src/components/EditorWorkspace.tsx'];
  const searches = [];
  await page.routeWebSocket('**/ws', (ws) => ws.send(JSON.stringify({ type: 'snapshot', sessions: [session] })));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const q = url.searchParams;
    let data = {};
    if (p.endsWith('/timeline')) data = [];
    else if (p.endsWith('/tree')) data = { path: q.get('path'), entries: q.get('path') ? [] : [{ name: 'docs', path: 'docs', kind: 'dir' }, { name: 'src', path: 'src', kind: 'dir' }, { name: 'README.md', path: 'README.md', kind: 'file' }, { name: 'note.txt', path: 'note.txt', kind: 'file' }], skipped: [], truncated: 0 };
    else if (p.endsWith('/files')) data = { files: all, truncated: false };
    else if (p.endsWith('/search')) {
      searches.push(q.get('q'));
      data = q.get('q') === 'title'
        ? { query: 'title', total: 1, truncated: false, files: [{ path: 'src/App.tsx', matches: [{ line: 3, column: 7, length: 5, text: 'const title = 1;', at: 6 }] }] }
        : { query: q.get('q'), total: 0, truncated: false, files: [] };
    }
    else if (p.endsWith('/line-marks')) data = q.get('path') === 'src/App.tsx'
      ? { against: '最後の記録（コミット）', marks: [{ kind: 'modified', start: 3, end: 3 }, { kind: 'added', start: 10, end: 12 }, { kind: 'deleted', start: 20, end: 20 }] }
      : { against: '最後の記録（コミット）', marks: [] };
    else if (p.endsWith('/raw')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"><rect width="300" height="120" fill="#38bdf8"/></svg>' });
    else if (p.endsWith('/file')) data = { path: q.get('path'), content: contents[q.get('path')] ?? '', size: 1 };
    else if (p === '/api/agents') data = { claude: { available: true }, codex: { available: true } };
    else if (p === '/api/settings') data = { settings: {}, file: 'C:/tower/config.json', version: 'test', needsRestart: [] };
    else if (p === '/api/bridge') data = { enabled: false, permissions: false };
    else if (p === '/api/usage') { const z = { count: 0, input: 0, cacheRead: 0, output: 0, cost: 0 }; data = { today: z, week: z, all: z, projectsToday: [] }; }
    else if (p === '/api/feedback') data = { notes: [], file: 'C:/feedback.md' };
    return route.fulfill({ json: data });
  });
  await page.goto(process.env.TOWER_TEST_URL ?? 'http://127.0.0.1:5179');
  await page.getByRole('button').filter({ hasText: 'Editor tools check' }).click();
  const tree = page.locator('aside').first();
  await tree.getByRole('button', { name: 'note.txt', exact: true }).waitFor();

  // 1) Ctrl+P: open by name
  await page.keyboard.press('Control+p');
  const quick = page.getByRole('dialog', { name: 'ファイル名で開く' });
  await quick.waitFor();
  await page.keyboard.type('app');
  assert.equal(await quick.getByRole('option').first().textContent(), 'App.tsxsrc');
  await page.screenshot({ path: 'docs/screenshots/editor-quick-open.png' });
  await page.keyboard.press('Enter');
  await quick.waitFor({ state: 'detached' });
  const appPanel = page.getByRole('tabpanel', { name: 'src/App.tsx', exact: true });
  await appPanel.locator('.monaco-editor').waitFor();

  // 2) changed-line marks and "next change"
  await appPanel.locator('.line-mark-modified').first().waitFor();
  assert.equal(await appPanel.locator('.line-mark-added').count(), 3);
  assert.equal(await appPanel.locator('.line-mark-deleted').count(), 1);
  const next = appPanel.getByRole('button', { name: '変わった所 3 か所 ↓' });
  await next.click();
  assert.equal(await appPanel.locator('.active-line-number').textContent(), '3');
  await next.click();
  assert.equal(await appPanel.locator('.active-line-number').textContent(), '10');

  // 3) Japanese editor UI: find widget and right-click menu
  await appPanel.locator('.view-lines').click();
  await page.keyboard.press('Control+f');
  const find = appPanel.locator('.find-widget textarea').first();
  await find.waitFor();
  assert.equal(await find.getAttribute('placeholder'), '検索');
  await page.keyboard.press('Escape');
  await appPanel.locator('.view-lines').click({ button: 'right' });
  await page.locator('.monaco-menu .action-label').first().waitFor();
  const menu = await page.locator('.monaco-menu .action-label').allTextContents();
  assert.ok(menu.some((t) => t.includes('コピー')), `menu: ${menu.join(' / ')}`);
  await page.keyboard.press('Escape');

  // Ctrl+P also works while typing in the editor, and does not type into it
  await appPanel.locator('.view-lines').click();
  await page.keyboard.press('Control+p');
  await quick.waitFor();
  await page.keyboard.press('Escape');
  await quick.waitFor({ state: 'detached' });
  assert.ok(!(await appPanel.locator('.view-lines').textContent()).includes('p'.repeat(2)));

  // 4) Ctrl+Shift+F: project-wide search, result opens at the line
  await appPanel.locator('.view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+Shift+F');
  const input = tree.getByLabel('プロジェクト全体から探す文字');
  await input.waitFor();
  assert.ok(await input.evaluate((el) => el === document.activeElement));
  await page.keyboard.type('title');
  await tree.getByRole('status').filter({ hasText: '1 件（1 ファイル）' }).waitFor();
  assert.equal(searches.at(-1), 'title');
  assert.equal(await tree.locator('mark').textContent(), 'title');
  await page.screenshot({ path: 'docs/screenshots/editor-search.png' });
  await tree.getByRole('button', { name: /src\/App\.tsx の 3 行目を開く|3const title/ }).click();
  await page.waitForFunction(() => document.querySelector('[role=tabpanel][aria-label="src/App.tsx"] .active-line-number')?.textContent === '3');

  // 5) Markdown: readable, sanitized, local links open project files
  await page.getByRole('navigation', { name: 'ワークスペース' }).getByRole('button', { name: 'ファイル', exact: true }).click();
  await tree.getByRole('button', { name: 'README.md', exact: true }).click();
  const readme = page.getByRole('article', { name: 'README.md の表示' });
  await readme.getByRole('heading', { name: '見出し' }).waitFor();
  assert.equal(await readme.locator('td').count(), 2);
  assert.equal(await readme.locator('input[type=checkbox]').count(), 2);
  assert.equal(await readme.locator('input[type=checkbox]:checked').count(), 1);
  assert.equal(await readme.locator('script').count(), 0);
  assert.equal(await readme.locator('[onerror]').count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await readme.getByRole('img', { name: '画面' }).getAttribute('src'), '/api/sessions/test/raw?path=docs%2Fimg%2Fshot.png');
  await page.screenshot({ path: 'docs/screenshots/editor-markdown.png' });
  const readmePanel = page.getByRole('tabpanel', { name: 'README.md', exact: true });
  await readmePanel.getByRole('button', { name: '編集', exact: true }).click();
  await readmePanel.locator('.monaco-editor').waitFor({ state: 'visible' });
  assert.equal(await readme.count(), 0);
  await readmePanel.getByRole('button', { name: '読みやすく表示', exact: true }).click();
  await page.getByRole('article', { name: 'README.md の表示' }).getByRole('link', { name: '案内' }).click();
  await page.getByRole('article', { name: 'docs/guide.md の表示' }).getByRole('heading', { name: '案内のページ' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'docs/guide.md', exact: true }).getAttribute('aria-selected'), 'true');

  assert.deepEqual(errors, []);
  console.log('PASS: open by name (also from inside the editor), changed-line marks and next change, Japanese find box and menu, project-wide search opening at the line, readable and sanitized Markdown with local links');
} catch (e) {
  // 失敗した時の手がかり: 開いているタブと画面の誤り
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    console.error('tabs:', await page.getByRole('tab').allTextContents().catch(() => []));
    console.error('articles:', await page.locator('article').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label'))).catch(() => []));
    await page.screenshot({ path: 'editor-tools-failure.png' }).catch(() => {});
  }
  throw e;
} finally { await browser.close(); }
