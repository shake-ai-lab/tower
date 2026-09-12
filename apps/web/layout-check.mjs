// 画面の構成（左の欄 × 中央 × チャット）の組み合わせを全部通し、どの構成でも判断待ちの「答える」で答える欄にたどり着けるかを見る。
// Vite を起動して TOWER_TEST_URL（既定 http://127.0.0.1:5179）で実行。API と WebSocket はすべてここで模擬するので、本物のタスクや設定には触らない。
// TOWER_SHOTS_DIR を渡すと、構成ごとの画面を撮って残す。
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const url = process.env.TOWER_TEST_URL ?? 'http://127.0.0.1:5179';
const shots = process.env.TOWER_SHOTS_DIR;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const now = Date.now();
  const base = { project: { name: 'editor', path: 'C:/projects/editor' }, agent: 'claude', status: 'idle', permissionMode: 'default', activity: 'Ready', changedFiles: [], createdAt: now - 60000, updatedAt: now - 60000, turns: 1, toolCalls: 2, costUsd: 0, pending: null, report: null };
  const task = (id, title, extra = {}) => ({ ...base, id, title, prompt: title, ...extra });
  const decision = { request: 'Pick a color', summary: ['Prepared two options'], changedFiles: [], details: null, needsDecision: 'Blue or green?', nextStep: null, outcome: 'question', raw: 'Blue or green?', generatedAt: now - 5000 };
  const sessions = [task('a', 'Task A'), task('b', 'Task B'), task('c', 'Task C'), task('d', 'Task D'), task('e', 'Needs your call', { report: decision, updatedAt: now - 5000 })];
  const sent = [];
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.error(e.stack); });
  // 利用者の報告どおりの状態から始める: 4分割・チャット無し・4 つのパネルは判断待ちでないタスクで埋まっている
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.clear();
    localStorage.setItem('tower.view', 'quad');
    localStorage.setItem('tower.quad-slots', JSON.stringify(['a', 'b', 'c', 'd']));
  });
  await page.routeWebSocket('**/ws', (ws) => ws.send(JSON.stringify({ type: 'snapshot', sessions })));
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    let data = {};
    if (p.endsWith('/timeline')) data = [];
    else if (p.endsWith('/message')) { sent.push({ id: p.split('/')[3], text: route.request().postDataJSON().text }); data = { ok: true }; }
    else if (p.endsWith('/tree')) data = { path: '', entries: [{ name: 'note.txt', path: 'note.txt', kind: 'file' }], skipped: [], truncated: 0 };
    else if (p.endsWith('/file')) data = { path: 'note.txt', content: 'Hello layout', size: 12 };
    else if (p.endsWith('/changes')) data = { isGit: false, files: [], history: [] };
    else if (p === '/api/agents') data = { claude: { available: true }, codex: { available: false, reason: 'Login required' } };
    else if (p === '/api/settings') data = { settings: { host: '127.0.0.1', port: 4800, projectRoots: ['C:/projects'], autoVerify: true, reformatReports: true, bridgeWaitSeconds: 90, externalKeepHours: 24, feedbackFile: 'C:/feedback.md' }, file: 'C:/tower/config.json', version: 'test', needsRestart: [] };
    else if (p === '/api/bridge') data = { enabled: false, permissions: false };
    else if (p === '/api/usage') { const z = { count: 0, input: 0, cacheRead: 0, output: 0, cost: 0 }; data = { today: z, week: z, all: z, projectsToday: [] }; }
    else if (p === '/api/feedback') data = { notes: [], file: 'C:/feedback.md' };
    return route.fulfill({ json: data });
  });
  await page.goto(url);

  const toolbar = page.getByRole('toolbar', { name: '画面の構成' });
  const center = toolbar.getByRole('navigation', { name: '中央の表示' });
  const segment = (label) => center.getByRole('button', { name: new RegExp(`^${label}`) });
  const toggle = (name) => toolbar.getByRole('button', { name, exact: true });
  const chat = page.getByRole('complementary', { name: 'チャット', exact: true });
  const rail = page.getByRole('navigation', { name: 'ワークスペース' });
  const answer = page.getByRole('button', { name: '答える', exact: true });
  const pick = async (label, title) => {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('dialog', { name: label }).getByRole('option').filter({ hasText: title }).click();
  };
  /** いま入力している指示欄が、どのタスクの欄か（チャットかパネルの見出しの題名） */
  const answeringIn = () => page.evaluate(() => {
    const box = document.activeElement?.tagName === 'TEXTAREA' ? document.activeElement.closest('.workspace-chat, .session-pane') : null;
    return box ? (box.querySelector('button[aria-haspopup="listbox"]')?.getAttribute('title') ?? '') : '';
  });
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  async function setLayout(sidebar, label, withChat) {
    for (const [name, want] of [['左の欄', sidebar], ['チャット', withChat]]) {
      if ((await toggle(name).getAttribute('aria-pressed')) !== String(want)) await toggle(name).click();
    }
    await segment(label).click();
  }

  // 1. 報告の不具合: 4分割でチャットを出していない時に「答える」を押すと、何も出なかった
  await page.getByLabel('4分割ビュー').waitFor();
  assert.equal(await toggle('チャット').getAttribute('aria-pressed'), 'false', '前の版の「4分割」はチャット無しで引き継ぐ');
  assert.equal(await page.getByText('開いて答える').count(), 0);
  await answer.click();
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
  assert.match(await answeringIn(), /Needs your call/);
  assert.match(await page.getByRole('button', { name: 'パネル1のタスク', exact: true }).getAttribute('title'), /Needs your call/, '一番長く触っていないパネルに出す');
  assert.match(await page.locator('.session-pane').first().getAttribute('class'), /reveal-flash/);
  await page.keyboard.type('Blue');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => true);
  assert.deepEqual(sent.at(-1), { id: 'e', text: 'Blue' });
  if (shots) await page.screenshot({ path: `${shots}/layout-quad-answer.png` });

  // 2. チャットを並べていれば、パネルを入れ替えずにチャットに出す
  await pick('パネル1のタスク', 'Task A');
  await toggle('チャット').click();
  await answer.click();
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('.workspace-chat'));
  assert.match(await chat.getByRole('button', { name: 'チャットのタスク' }).getAttribute('title'), /Needs your call/);
  assert.equal(await page.locator('.session-pane button[aria-haspopup="listbox"][title*="Needs your call"]').count(), 0);

  // 3. キー操作: Ctrl+B で左の欄、Ctrl+Alt+B でチャット。上の「判断待ち」で左の欄と判断待ちが出る
  await page.getByRole('banner').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+b');
  assert.equal(await rail.isVisible(), false);
  assert.equal(await toggle('左の欄').getAttribute('aria-pressed'), 'false');
  await page.keyboard.press('Control+Alt+b');
  assert.equal(await chat.count(), 0);
  await page.getByRole('banner').getByRole('button', { name: /^判断待ち/ }).click();
  assert.ok(await rail.isVisible());
  assert.ok(await page.getByRole('complementary', { name: '判断インボックス' }).isVisible());
  await page.keyboard.press('Control+Alt+b');
  assert.ok(await chat.isVisible());
  // 左の欄の « とチャットの ✕ でも隠せる
  await page.getByRole('button', { name: '左の欄を隠す' }).click();
  await page.getByRole('button', { name: 'チャットを隠す' }).click();
  assert.equal(await rail.isVisible(), false);
  assert.equal(await chat.count(), 0);

  // 4. 全部の組み合わせ: 左の欄 2 × 中央 6 × チャット 2。どれでも崩れず、「答える」で答える欄にたどり着く
  const CENTER = [['開いたファイル', 'files'], ['自由配置', 'desk'], ['カード', 'cards'], ['コンパクト', 'compact'], ['集中', 'focus'], ['4分割', 'quad']];
  for (const sidebar of [true, false]) for (const withChat of [true, false]) for (const [label, key] of CENTER) {
    const name = [sidebar && '左の欄', label, withChat && 'チャット'].filter(Boolean).join('＋');
    await setLayout(sidebar, label, withChat);
    assert.equal(await segment(label).getAttribute('aria-pressed'), 'true', name);
    assert.equal(await center.locator('button[aria-pressed="true"]').count(), 1, `${name}: 中央のボタンが 1 つだけ選ばれている`);
    if (key === 'files' || key === 'desk') {
      const editorPressed = await page.getByRole('region', { name: 'ファイルエディタ' }).locator('header button[aria-pressed="true"]').allTextContents();
      assert.equal(editorPressed.length, 1, `${name}: 編集領域の並べ方`);
      assert.equal(editorPressed[0] === '自由に配置', key === 'desk', `${name}: 編集領域の並べ方が中央の選択と合う`);
    }
    if (shots && key === 'desk' && !sidebar && withChat) { await page.mouse.move(0, 500); await toolbar.screenshot({ path: `${shots}/toolbar-desk.png` }); }
    assert.equal(await rail.isVisible(), sidebar, `${name}: 左の欄`);
    assert.equal(await chat.isVisible(), withChat, `${name}: チャット`);
    assert.ok((await toolbar.textContent()).includes(`いまの画面: ${[sidebar && '左の欄', label, withChat && 'チャット'].filter(Boolean).join(' ＋ ')}`), `${name}: 構成の説明`);
    const region = key === 'files' || key === 'desk' ? page.getByRole('region', { name: 'ファイルエディタ' })
      : key === 'focus' ? page.getByLabel('集中ビュー') : key === 'quad' ? page.getByLabel('4分割ビュー') : page.locator('main');
    assert.ok(await region.isVisible(), `${name}: 中央`);
    if (key === 'desk') assert.ok(await page.getByLabel('自由配置のデスク', { exact: true }).isVisible(), `${name}: 自由配置`);
    if (key === 'files') assert.equal(await page.getByLabel('自由配置のデスク', { exact: true }).count(), 0, `${name}: 自由配置ではない`);
    const width = (await region.boundingBox()).width;
    assert.ok(width >= 300, `${name}: 中央の幅 ${width}`);
    if (withChat) assert.ok((await chat.boundingBox()).width >= 290, `${name}: チャットの幅`);
    assert.ok(await noSideScroll(), `${name}: 横にはみ出す`);
    if (shots) await page.screenshot({ path: `${shots}/layout-${key}-${sidebar ? 'side' : 'noside'}-${withChat ? 'chat' : 'nochat'}.png` });
    // 左の欄を隠している時は、上の「判断待ち」から判断待ちを出して答える
    if (!sidebar) await page.getByRole('banner').getByRole('button', { name: /^判断待ち/ }).click();
    await answer.click();
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', undefined, { timeout: 3000 }).catch(() => {});
    assert.match(await answeringIn(), /Needs your call/, `${name}: 「答える」で答える欄に入力できない`);
    assert.ok(await noSideScroll(), `${name}: 答えた後に横にはみ出す`);
  }

  // 5. 選んだ構成は次に開いた時も残る
  await setLayout(false, '自由配置', true);
  await page.reload();
  await page.getByRole('region', { name: 'ファイルエディタ' }).waitFor();
  assert.equal(await toggle('左の欄').getAttribute('aria-pressed'), 'false');
  assert.equal(await toggle('チャット').getAttribute('aria-pressed'), 'true');
  assert.equal(await segment('自由配置').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.getByLabel('自由配置のデスク', { exact: true }).isVisible());
  assert.ok(await chat.isVisible());
  assert.equal(await rail.isVisible(), false);

  // 6. 狭い画面: チャットを並べられない 4分割は、パネルに出す
  await page.setViewportSize({ width: 1000, height: 900 });
  await setLayout(true, '4分割', true);
  assert.equal(await chat.count(), 0);
  for (let i = 1; i <= 4; i++) {
    const t = await page.getByRole('button', { name: `パネル${i}のタスク`, exact: true }).getAttribute('title');
    if (/Needs your call/.test(t ?? '')) await pick(`パネル${i}のタスク`, 'Task A');
  }
  await answer.click();
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
  assert.match(await answeringIn(), /Needs your call/);
  assert.ok(await noSideScroll());
  // カードでは、選ぶと詳細を画面いっぱいに重ねる（前と同じ）。選んでいるタスクの詳細が重なっていれば、先に閉じる
  await segment('カード').click();
  const overlay = page.getByRole('region', { name: 'タスク詳細' });
  if (await overlay.isVisible()) await overlay.getByRole('button', { name: '閉じる', exact: true }).click();
  await answer.click();
  assert.ok(await page.getByRole('button', { name: 'ファイル・Git・設定を見る' }).isVisible());
  assert.match(await overlay.textContent(), /Needs your call/);
  assert.ok(await noSideScroll());
  await overlay.getByRole('button', { name: '閉じる', exact: true }).click();

  // 7. スマホ幅: 下のタブで「判断待ち」から答えると、中央（4分割）に切り替わる
  await page.setViewportSize({ width: 390, height: 844 });
  await segment('4分割').click();
  for (let i = 1; i <= 4; i++) {
    const t = await page.getByRole('button', { name: `パネル${i}のタスク`, exact: true }).getAttribute('title');
    if (/Needs your call/.test(t ?? '')) await pick(`パネル${i}のタスク`, 'Task B');
  }
  await page.getByRole('button', { name: /^ワークスペース/ }).click();
  await answer.click();
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
  assert.match(await answeringIn(), /Needs your call/);
  assert.ok(await page.getByLabel('4分割ビュー').isVisible());
  assert.ok(await noSideScroll());
  if (shots) await page.screenshot({ path: `${shots}/layout-mobile-quad.png` });

  assert.deepEqual(errors, []);
  console.log('PASS: 4分割で「答える」がパネルに出る・チャットがあればチャットに出る・Ctrl+B / Ctrl+Alt+B・左の欄×中央×チャットの 24 通り全部で「答える」から入力できる・構成が残る・狭い画面とスマホ幅');
} finally { await browser.close(); }
