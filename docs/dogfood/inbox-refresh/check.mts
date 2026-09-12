import { chromium } from 'playwright-core';
import { installFixture } from '../../../apps/user-agent/src/browser-fixture.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Isolated API/WS fixtures: never connect to the user's backend.
const out = new URL('./', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [220, 320, 390]) {
    const mobile = width === 390;
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: 900 } });
    await installFixture(context);
    const sessions = [1, 2, 3].map((n) => ({
      id: `inbox-${n}`, agent: 'claude', agentSessionId: null,
      project: { path: 'C:/inbox-fixture', name: 'editor' },
      title: `判断事項 ${n}：作業完了後の確認`, prompt: '検証', model: null,
      permissionMode: 'default', status: 'idle', activity: '', pending: null,
      report: { request: '検証', raw: '検証用の報告', changedFiles: [], outcome: 'question', summary: ['作業が完了しました'],
        needsDecision: '別セッションの作業が終わった後、見送られた項目（VS Code側のタイムアウト後の許可待ち表示、ポート変更後のhooks参照、ブラウザのCtrl+W、Tower終了時のサーバー停止）をどうするか判断してください。',
        nextStep: '対応可否を確認した上で、コミットと検証を実施してください。',
        details: '補足の最終行まで読むことができます。', generatedAt: Date.now() - n * 60000 },
      turns: 0, costUsd: 0, toolCalls: 0, changedFiles: [], createdAt: Date.now(), updatedAt: Date.now(), lastError: null,
    }));
    await context.routeWebSocket('**/ws', ws => ws.send(JSON.stringify({ type: 'snapshot', sessions })));
    await context.route('**/api/sessions', route => route.fulfill({ json: sessions }));
    await context.addInitScript(({ width }) => {
      localStorage.setItem('tower.width.sidebar', String(width));
      localStorage.setItem('tower.layout', JSON.stringify({ sidebar: true, main: 'cards', chat: false }));
    }, { width });
    const page = await context.newPage();
    page.on('pageerror', error => console.error(error.message));
    await page.goto('http://127.0.0.1:5188');
    if (mobile) await page.getByRole('button', { name: '判断待ち 3', exact: true }).first().click();
    const inbox = page.getByRole('complementary', { name: '判断インボックス' });
    await inbox.waitFor();
    await inbox.getByRole('button', { name: '答える', exact: true }).first().waitFor();
    const metrics = await inbox.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth,
      heights: [...el.querySelectorAll('.line-clamp-4')].map(p => p.getBoundingClientRect().height) }));
    assert.equal(metrics.scroll, metrics.width, 'no horizontal inbox overflow');
    assert.equal(metrics.heights.length, 3);
    assert.ok(metrics.heights.every(h => h <= 85), 'four-line previews');
    await page.screenshot({ path: new URL(`width-${width}.png`, out).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
    await inbox.locator('summary').first().click();
    assert.ok(await inbox.getByText('補足の最終行まで読むことができます。', { exact: true }).first().isVisible());
    await inbox.locator('summary').first().click();
    await inbox.getByRole('button', { name: '答える', exact: true }).first().click();
    await page.screenshot({ path: new URL(`answer-${width}.png`, out).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
    const input = page.locator('textarea:visible').first();
    await input.fill('確認しました（検証用・送信しません）');
    assert.equal(await input.inputValue(), '確認しました（検証用・送信しません）');
    results.push({ width, metrics, expand: 'pass', answerNavigationAndInput: 'pass' });
    await context.close();
  }
  await writeFile(new URL('report.json', out), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); }
