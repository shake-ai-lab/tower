import { chromium, type WebSocketRoute } from 'playwright-core';
import { installFixture } from '../../../apps/user-agent/src/browser-fixture.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Only the backend boundary is mocked. No application store is accessed.
const out = new URL('./', import.meta.url);
await mkdir(out, { recursive: true });
const target = 'http://127.0.0.1:5191';
const vite = spawn(process.execPath, ['../../node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5191', '--strictPort'], {
  cwd: fileURLToPath(new URL('../../../apps/web/', import.meta.url)), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let viteOutput = ''; vite.stdout.on('data', b => viteOutput += b); vite.stderr.on('data', b => viteOutput += b);
const results: unknown[] = [], errors: string[] = [], actions: string[] = [];
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (vite.exitCode !== null) throw Error(`Vite exited: ${viteOutput}`);
    try { if ((await fetch(target)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1160, height: 1000 } });
  const fixture = await installFixture(context);
  const now = Date.now(), instruction = '元のプロジェクトに取り込んでください。';
  let time = now;
  let session: any = {
    id: 'timeline-fixture', agent: 'claude', agentSessionId: 'fixture-only',
    project: { path: 'C:/timeline-fixture', name: '時系列検証用プロジェクト' }, title: '報告と取り込みの順序を確認', prompt: '検証',
    model: null, permissionMode: 'default', status: 'idle', activity: '架空の報告を受信', pending: null,
    report: { request: '取り込み案内の時系列を確認', raw: `【報告】\n次の一手: ${instruction}`, changedFiles: [], outcome: 'partial', summary: ['検証用の変更を用意しました。'], needsDecision: null, nextStep: instruction, generatedAt: now - 1000 },
    verification: { at: now - 500, ok: true, command: 'fixture-check', summary: '全部成功（3件）', output: '3 passed', failed: [] },
    workspace: { path: 'C:/timeline-fixture-copy', root: 'C:/timeline-fixture-copy', branch: 'tower/timeline-fixture', baseBranch: 'main', baseCommit: 'fixture', lastMerge: null },
    turns: 1, costUsd: 0, toolCalls: 0, changedFiles: [], createdAt: now - 3000, updatedAt: now, lastInstructionAt: now - 2000, lastError: null,
  };
  const sockets: WebSocketRoute[] = [];
  const publish = () => sockets.forEach(ws => ws.send(JSON.stringify({ type: 'session', session })));
  await context.routeWebSocket('**/ws', ws => { sockets.push(ws); ws.send(JSON.stringify({ type: 'snapshot', sessions: [session] })); });
  await context.route('**/api/sessions', route => route.fulfill({ json: [session] }));
  let mergeAttempts = 0;
  await context.route('**/api/sessions/timeline-fixture/*', async route => {
    const path = new URL(route.request().url()).pathname, action = path.split('/').pop();
    if (action === 'timeline') return route.fulfill({ json: [] });
    if (route.request().method() !== 'POST') return route.fallback();
    actions.push(action!); time += 1000;
    if (action === 'merge') {
      mergeAttempts++;
      session.workspace.lastMerge = { at: time, ok: mergeAttempts > 1, message: mergeAttempts > 1 ? '取り込みが完了しました（架空データ）' : '取り込みに失敗しました（検証用）' };
    } else if (action === 'message') {
      session = { ...session, status: 'running', lastInstructionAt: time, updatedAt: time, activity: '追加の指示で作業を再開', completedByUser: null };
    } else if (action === 'stop') session = { ...session, status: 'stopped', activity: '停止しました' };
    else if (action === 'complete') session = { ...session, status: 'done', completedByUser: time, activity: '利用者が完了にしました' };
    else return route.fulfill({ status: 501, json: { error: '検証対象外' } });
    publish();
    return route.fulfill({ json: action === 'complete' ? session : { ok: true } });
  });
  await context.addInitScript(() => {
    localStorage.setItem('tower.layout', JSON.stringify({ sidebar: false, main: 'focus', chat: false }));
    localStorage.setItem('tower.focus-task', 'timeline-fixture');
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(target);
  const detail = page.getByRole('region', { name: 'タスク詳細' });
  await detail.waitFor();
  const visible = async (text: string) => assert.ok(await detail.getByText(text, { exact: true }).isVisible(), text);
  const hidden = async (text: string) => assert.equal(await detail.getByText(text, { exact: true }).isVisible(), false, text);
  const capture = async (name: string, assertions: string[]) => {
    await detail.locator('.overflow-y-auto').first().evaluate(el => el.scrollTop = 0);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, out)), fullPage: true });
    await writeFile(new URL(`${name}.yml`, out), await detail.ariaSnapshot());
    results.push({ name, assertions, status: 'pass', capturedAt: new Date().toISOString(), target, project: session.project.name });
  };
  await visible(instruction);
  assert.ok(await detail.getByRole('button', { name: '元のプロジェクトに取り込む', exact: true }).isEnabled());
  await capture('01-before-merge', ['取り込み案内が見える', '取り込みボタンが有効']);
  await detail.getByRole('button', { name: '元のプロジェクトに取り込む', exact: true }).click();
  await detail.getByText('取り込みに失敗しました（検証用）', { exact: false }).waitFor();
  await visible(instruction);
  assert.ok(await detail.getByRole('button', { name: '元のプロジェクトに取り込む', exact: true }).isEnabled());
  await capture('02-merge-failed', ['失敗後も案内が見える', '再試行できる']);
  await detail.getByRole('button', { name: '元のプロジェクトに取り込む', exact: true }).click();
  await detail.getByRole('button', { name: '取り込み済み', exact: true }).waitFor();
  assert.ok(await detail.getByRole('button', { name: '取り込み済み', exact: true }).isDisabled());
  await hidden(instruction);
  await visible('この報告までの変更は、元のプロジェクトに取り込み済みです。再度取り込む必要はありません。');
  await capture('03-merged', ['古い取り込み案内は折り畳み', '取り込み済み説明', '取り込みボタン無効']);
  await detail.getByText('報告時点の提案を見る（履歴）', { exact: true }).click();
  await visible(instruction); await visible('当時の次の一手');
  await capture('04-history-expanded', ['履歴展開で古い提案を読める']);
  await detail.getByText('報告時点の提案を見る（履歴）', { exact: true }).click();
  await detail.locator('textarea').fill('追加の作業をお願いします（架空データ）');
  await detail.locator('textarea').press('Control+Enter');
  await detail.locator('summary').filter({ hasText: '前回の報告を見る' }).waitFor();
  await hidden(instruction);
  assert.ok(await detail.locator('summary').filter({ hasText: '前回の自動チェックを見る' }).isVisible());
  assert.ok(await detail.getByText('前回の取り込み結果:', { exact: false }).isVisible());
  assert.ok(await detail.getByRole('button', { name: '追加の変更を取り込む', exact: true }).isDisabled());
  await capture('05-resumed', ['前回報告・チェックが折り畳み', '取り込み結果に前回の明記', '作業中は追加取り込み無効']);
  await detail.getByRole('button', { name: '停止', exact: true }).click();
  await detail.getByText('停止しました', { exact: true }).waitFor();
  await hidden(instruction);
  assert.ok(await detail.locator('summary').filter({ hasText: '前回の報告を見る' }).isVisible());
  assert.ok(await detail.locator('summary').filter({ hasText: '前回の自動チェックを見る' }).isVisible());
  assert.ok(await detail.getByRole('button', { name: '追加の変更を取り込む', exact: true }).isEnabled());
  await capture('06-stopped', ['停止後も古い報告・チェックは履歴', '追加取り込み操作は有効']);
  session = { ...session, status: 'error', activity: '検証用の接続エラー', lastError: '架空の接続失敗' }; publish();
  await detail.getByText('検証用の接続エラー', { exact: true }).waitFor();
  await hidden(instruction);
  assert.ok(await detail.locator('summary').filter({ hasText: '前回の報告を見る' }).isVisible());
  assert.ok(await detail.locator('summary').filter({ hasText: '前回の自動チェックを見る' }).isVisible());
  await capture('07-error', ['エラー後も古い報告・チェックは履歴']);
  time += 1000;
  const newInstruction = '追加分の内容を確認してください。';
  session = { ...session, status: 'idle', activity: '新しい報告を受信', lastError: null, report: { ...session.report, generatedAt: time, summary: ['追加の変更を用意しました。'], nextStep: newInstruction } }; publish();
  await detail.getByText(newInstruction, { exact: true }).waitFor();
  await visible('次の一手');
  assert.equal(await detail.locator('summary').filter({ hasText: '前回の報告を見る' }).count(), 0);
  assert.ok(await detail.getByRole('button', { name: '追加の変更を取り込む', exact: true }).isEnabled());
  await capture('08-new-report', ['新報告の案内が再表示', '新しい変更の取り込みが有効']);
  await detail.getByRole('button', { name: '完了にする', exact: true }).click();
  await detail.getByText('この報告の後、利用者がタスクを完了にしました。', { exact: true }).waitFor();
  await hidden(newInstruction);
  await capture('09-user-completed', ['利用者完了後は提案を履歴に移す']);
  await detail.getByText('報告時点の提案を見る（履歴）', { exact: true }).click();
  await visible(newInstruction);
  await capture('10-completed-history', ['利用者完了後も履歴展開で提案を読める']);
  assert.deepEqual(errors, [], 'no browser exceptions');
  await writeFile(new URL('report.json', out), JSON.stringify({ result: 'pass', checkedAt: new Date().toISOString(), target, browser: 'Edge headless', fixtures: 'all API/WS intercepted', results, actions, errors, unmatchedBlockedRequests: fixture.unexpected }, null, 2));
  console.log(JSON.stringify({ result: 'pass', scenarios: results.length, actions, errors, unmatchedBlockedRequests: fixture.unexpected }));
} catch (e) {
  await writeFile(new URL('failure.json', out), JSON.stringify({ error: String(e), results, errors, viteOutput }, null, 2));
  throw e;
} finally { await browser?.close(); vite.kill(); }
