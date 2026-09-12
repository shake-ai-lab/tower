// AI chooses one next action from the visible UI, then observes the result again.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { llmJson } from './llm.ts';
import { performAction } from './browser-actions.ts';

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    thought: { type: 'string' },
    action: { type: 'string', enum: ['click', 'type', 'press', 'select', 'scroll', 'finish'] },
    target: { type: 'integer', minimum: -1 },
    value: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
  }, required: ['thought', 'action', 'target', 'value', 'findings'],
};
type Decision = { thought: string; action: 'click' | 'type' | 'press' | 'select' | 'scroll' | 'finish'; target: number; value: string; findings: string[] };

export async function explore(page: Page, out: string, model: string, steps: number, goal: string) {
  const history: { step: number; decision: Decision; viewKey: string; result?: string; error?: string }[] = [];
  let error = '', finished = false;
  await fs.mkdir(out, { recursive: true });
  // Dialogs are observable and dismissed; saving is isolated in the fixture.
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  for (let step = 1; step <= steps; step++) {
    const controls = page.locator('button, input, textarea, select, summary, a, [role="option"], [role="tab"], [role="textbox"]');
    const targets = [];
    const labels: string[] = [];
    for (let i = 0; i < await controls.count(); i++) {
      const el = controls.nth(i);
      if (!await el.isVisible() || !await el.isEnabled()) continue;
      const label = await el.getAttribute('aria-label') || await el.getAttribute('title') || await el.getAttribute('placeholder') || (await el.innerText()).slice(0, 120);
      const focused = await el.evaluate((node) => node === node.ownerDocument.activeElement);
      labels.push(`${targets.length}: ${label || '(名前なし)'} [${await el.getAttribute('role') || await el.evaluate((node) => node.tagName)}]${focused ? ' 【現在の入力先・フォーカスあり】' : ''}`);
      targets.push(el);
    }
    const snapshot = await page.locator('body').ariaSnapshot();
    const shot = await page.screenshot({ path: path.join(out, `${step}.png`) });
    await fs.writeFile(path.join(out, `${step}.yml`), snapshot);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 90000);
    let decision: Decision;
    try {
      decision = await llmJson<Decision>(
        'あなたは日本語のエディターを初めて使う利用者役です。ソースコードやAPIは見られません。画面だけを頼りに目的を達成し、不満を探してください。1回に1操作。見ていない問題を捏造しない。履歴は実行済みの操作です。成功したクリックを繰り返さず次の入力・保存へ進んでください。「現在の入力先」にはすぐ文字を打てます（type、target=-1）。失敗した操作は別の手段を試す。findingsには実際の観察と再現手順を短く書く。',
        `目的: ${goal}\n現在の画面:\n${snapshot.slice(0, 18000)}\n操作対象番号:\n${labels.join('\n')}\n履歴:\n${JSON.stringify(history).slice(-12000)}\n確認ダイアログ（キャンセル済）:${JSON.stringify(dialogs)}\nclick/selectは対象番号必須。typeは対象にfocusして文字を入力、既存内容の全選択はpressでControl+a。pressはPlaywright形式のキー（例Control+p, Enter, Escape）、target=-1なら現在の入力先。scrollはdown/upをvalueに指定。finishは目的達成または行き詰まり。ソースを推測して操作せず、表示された対象だけ使ってください。`,
        schema, model, [{ data: shot.toString('base64'), mediaType: 'image/png' }], abort,
      );
    } catch (e) { error = String(e); break; }
    finally { clearTimeout(timer); }
    const entry: typeof history[number] = { step, decision, viewKey: createHash('sha256').update(snapshot).digest('hex') }; history.push(entry);
    console.log(`探索 ${step}/${steps}: ${decision.thought} → ${decision.action}`);
    try {
      if (decision.action === 'finish') { finished = true; break; }
      if (decision.action === 'click' && history.slice(-3, -1).length === 2 && history.slice(-3, -1).every((item) => item.result && item.viewKey === entry.viewKey && item.decision.action === 'click' && item.decision.target === decision.target)) {
        throw new Error('同じクリックがすでに2回成功しています。現在の入力先を確認し、入力など別の操作へ進んでください。');
      }
      await performAction(page, decision, targets);
      await page.waitForTimeout(400); // 利用者が操作後の画面を読む間隔
      entry.result = 'ブラウザ操作は成功しました。次の画面で結果を確認し、目的の次の手順へ進んでください。';
    } catch (e) { entry.error = String(e); }
    await fs.writeFile(path.join(out, 'history.json'), JSON.stringify(history, null, 2));
  }
  await fs.writeFile(path.join(out, 'history.json'), JSON.stringify({ goal, model, finished, error, history, dialogs }, null, 2));
  await fs.writeFile(path.join(out, 'report.md'), [
    '# AI利用者役の自由探索', '', `目的: ${goal}`, '',
    `モデル: ${model} / ${history.length}操作 / ${error ? 'モデル実行失敗' : finished ? '終了判断' : '操作上限に到達'}`, '',
    '以下はAIの観察候補です。確定した不具合とする前に再現確認してください。', '',
    error, ...history.flatMap(({ step, decision, error }) => [
      `## 操作 ${step}`, '', decision.thought, '', `${decision.action} / 対象 ${decision.target} / ${decision.value}`, '',
      ...decision.findings.map((f) => `- ${f}`), ...(error ? [`操作エラー: ${error}`] : []), '', `[操作前の画面](${step}.png) / [画面の読み取り](${step}.yml)`, '',
    ]),
  ].join('\n'));
  if (error) throw new Error(`自由探索を実行できませんでした: ${error}`);
}
