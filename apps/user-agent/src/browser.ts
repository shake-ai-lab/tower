// Repeatable human journeys through the real UI; no application-state injection.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { installFixture } from './browser-fixture.ts';
import { performAction } from './browser-actions.ts';

const args = process.argv.slice(2);
function arg(name: string, fallback: string) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} の値が必要です`);
  return args[i + 1];
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const url = arg('--url', 'http://127.0.0.1:5173');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(root, arg('--out', `docs/dogfood/browser-${runId}`));
const headed = args.includes('--headed');
const only = arg('--only', '').split(',').filter(Boolean);
const waitFor = async (check: () => Promise<boolean>, message: string, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(message);
};
type Fixture = Awaited<ReturnType<typeof installFixture>>;
type Journey = { id: string; goal: string; steps: string[]; run: (p: Page, f: Fixture) => Promise<void> };
const searchInput = (p: Page) => p.getByRole('textbox', { name: 'プロジェクト全体から探す文字' });
async function searchApple(p: Page) {
  await p.keyboard.press('Control+Shift+f');
  await searchInput(p).fill('apple');
  await p.getByRole('status').filter({ hasText: '2 件' }).waitFor();
}
async function quickOpen(p: Page, file = 'notes.txt') {
  await p.keyboard.press('Control+p');
  await p.getByLabel('開くファイルの名前', { exact: true }).fill(file);
  await p.getByRole('option').first().waitFor();
  await p.keyboard.press('Enter');
  await p.getByRole('dialog', { name: 'ファイル名で開く' }).waitFor({ state: 'hidden' });
  await p.locator('.monaco-editor:visible').first().waitFor();
}
const journeys: Journey[] = [
  { id: 'pointer-edit', goal: 'AI操作器が本文の表示座標をクリックし、現在の入力先に文字を打って保存できる',
    steps: ['notes.txt を開く', '本文の入力要素の表示座標をクリック', '現在の入力先に pointer-check を打つ', 'Ctrl+Sで保存'],
    run: async (p) => {
      await quickOpen(p);
      const editor = p.getByRole('textbox', { name: 'エディターのコンテンツ', exact: true });
      await performAction(p, { action: 'click', target: 0, value: '' }, [editor]);
      await performAction(p, { action: 'type', target: -1, value: 'pointer-check' }, []);
      await waitFor(async () => (await p.locator('.monaco-editor:visible .view-lines').innerText()).includes('pointer-check'), '本文のクリック後に文字が入力されない');
      await performAction(p, { action: 'press', target: -1, value: 'Control+s' }, []);
      await p.getByText(/✔ 保存しました/).waitFor();
    } },
  { id: 'search-return', goal: 'ファイルを確認して検索へ戻っても、探していた内容を失わない',
    steps: ['Ctrl+Shift+F → apple を検索', '大文字と小文字を区別するをオン', 'ファイルへ移動', '検索へ戻る'],
    run: async (p) => {
      await searchApple(p);
      await p.getByRole('checkbox', { name: '大文字と小文字を区別する' }).check();
      await p.getByRole('button', { name: 'ファイル', exact: true }).click();
      await p.getByRole('button', { name: '検索', exact: true }).click();
      if (await searchInput(p).inputValue() !== 'apple') throw new Error('検索へ戻ると入力した apple が消えた');
      if (!await p.getByRole('checkbox', { name: '大文字と小文字を区別する' }).isChecked()) throw new Error('検索条件が解除された');
      await p.getByRole('status').filter({ hasText: '2 件' }).waitFor();
    } },
  { id: 'search-error', goal: '検索に失敗したとき、前の検索結果を現在の結果と取り違えない',
    steps: ['apple を検索', '次の検索通信を失敗させる', 'banana を検索', 'エラーと結果一覧を読む'],
    run: async (p, f) => {
      await searchApple(p); f.faults.search = true;
      await searchInput(p).fill('banana');
      await p.getByRole('alert').filter({ hasText: '検索サーバー' }).waitFor();
      if (await p.getByRole('list', { name: '検索結果', exact: true }).getByRole('button').count())
        throw new Error('banana の検索失敗後に apple の古い結果が残る');
      f.faults.search = false;
      await searchInput(p).fill('apple');
      await p.getByRole('status').filter({ hasText: '2 件' }).waitFor();
    } },
  { id: 'search-pending', goal: '通信待ちの間も、いま検索している条件を誤解しない',
    steps: ['apple を検索', '検索通信を1秒遅くする', 'banana を検索', '待機中の表示と最終結果を確認'],
    run: async (p, f) => {
      await searchApple(p); f.faults.searchDelay = 1000;
      await searchInput(p).fill('banana');
      await p.getByText('探しています…', { exact: true }).waitFor();
      if (await p.getByRole('list', { name: '検索結果', exact: true }).getByRole('button').count())
        throw new Error('banana を探している間に apple の結果をクリックできてしまう');
      await p.getByRole('status').filter({ hasText: '1 件' }).waitFor();
    } },
  { id: 'quick-open-type', goal: '名前でファイルを開き、そのままキーボードで編集する',
    steps: ['Ctrl+P → notes.txt → Enter', 'マウスで本文を押さずに typing-check と入力', '未保存表示を確認'],
    run: async (p) => {
      await quickOpen(p);
      await p.keyboard.type('typing-check', { delay: 60 });
      await waitFor(() => p.getByText('● 未保存', { exact: true }).isVisible(), '名前で開いた直後の文字入力がエディタに届かない');
    } },
  { id: 'search-after-save', goal: '検索で見つけたファイルを編集した後、検索へ戻ると最新の結果が見える',
    steps: ['apple を検索', 'notes.txt の検索結果を開く', '末尾に apple を追記して保存', 'ファイル一覧から検索へ戻る'],
    run: async (p) => {
      await searchApple(p);
      await p.getByTitle('notes.txt の 2 行目を開く', { exact: true }).click();
      await p.locator('.monaco-editor:visible').waitFor();
      await p.locator('.monaco-editor:visible .view-lines').click();
      await p.keyboard.press('Control+End'); await p.keyboard.type('\napple', { delay: 60 });
      await p.keyboard.press('Control+s');
      await p.getByText(/✔ 保存しました/).waitFor();
      await p.getByRole('button', { name: 'ファイル', exact: true }).click();
      await p.getByRole('button', { name: '検索', exact: true }).click();
      await p.getByRole('status').filter({ hasText: '3 件' }).waitFor();
    } },
  { id: 'loading-focus', goal: 'ファイルの読込中に検索へ移ったら、読込完了後も検索を続けられる',
    steps: ['ファイルの読込を1.5秒遅くする', 'Ctrl+P → notes.txt', '読込中に検索へ移動して入力', '読込完了後の入力先を確認'],
    run: async (p, f) => {
      f.faults.fileDelay = 1500;
      await p.keyboard.press('Control+p');
      await p.getByLabel('開くファイルの名前', { exact: true }).fill('notes.txt');
      await p.getByRole('option').first().waitFor(); await p.keyboard.press('Enter');
      await p.getByRole('dialog', { name: 'ファイル名で開く' }).waitFor({ state: 'hidden' });
      await p.keyboard.press('Control+Shift+f'); await searchInput(p).fill('apple');
      await p.locator('.monaco-editor:visible').waitFor();
      await p.waitForTimeout(150); // 読込後のフォーカス処理も含めて確認
      if (!await searchInput(p).evaluate((el) => el === el.ownerDocument.activeElement)) throw new Error('ファイル読込完了時に検索入力からフォーカスを奪った');
    } },
  { id: 'quick-open-reopen', goal: 'すでに開いているファイルも名前で選び直して入力できる',
    steps: ['notes.txt を開く', 'もう一度 Ctrl+P → notes.txt → Enter', 'マウスを使わず再入力'],
    run: async (p) => {
      await quickOpen(p); await quickOpen(p);
      await p.keyboard.type('reopen-check', { delay: 60 });
      await waitFor(() => p.getByText('● 未保存', { exact: true }).isVisible(), '開いていたファイルを再選択しても入力先が戻らない');
    } },
  { id: 'quick-open-loading', goal: 'ファイル一覧の読込中に矢印を押しても Enter で開ける',
    steps: ['一覧の読込を1秒遅くする', 'Ctrl+P → 読込中に↓', '候補の読込完了後 Enter'],
    run: async (p, f) => {
      f.faults.filesDelay = 1000;
      await p.keyboard.press('Control+p');
      await p.getByText('ファイルの一覧を読み込み中…').waitFor();
      await p.keyboard.press('ArrowDown');
      await p.getByRole('option').first().waitFor();
      await p.keyboard.press('Enter');
      await waitFor(async () => !await p.getByRole('dialog', { name: 'ファイル名で開く' }).isVisible(), '読込中に↓を押すと候補が選択されず Enter で開けない');
    } },
  { id: 'quick-open-cancel', goal: '名前で開くのを取り消したら、直前の本文で編集を続ける',
    steps: ['notes.txt の本文をクリック', 'Ctrl+P → Esc', 'そのまま文字を入力'],
    run: async (p) => {
      await quickOpen(p);
      await p.locator('.monaco-editor:visible .view-lines').first().click();
      await p.keyboard.press('Control+p');
      await p.getByRole('dialog', { name: 'ファイル名で開く' }).waitFor();
      await p.keyboard.press('Escape');
      await p.keyboard.type('cancel-check', { delay: 60 });
      await waitFor(() => p.getByText('● 未保存', { exact: true }).isVisible(), '取り消した後に元の本文へ入力先が戻らない');
    } },
  { id: 'quick-open-tab', goal: 'ファイル選択中のTab操作で背面の画面に迷い込まない',
    steps: ['Ctrl+P', 'Tab と Shift+Tab', 'ファイル名入力のフォーカスを確認'],
    run: async (p) => {
      await p.keyboard.press('Control+p');
      const input = p.getByLabel('開くファイルの名前', { exact: true });
      await input.waitFor();
      for (const key of ['Tab', 'Shift+Tab']) {
        await p.keyboard.press(key);
        if (!await input.evaluate((el) => el === el.ownerDocument.activeElement)) throw new Error('Tabでファイル選択の背面へフォーカスが逃げた');
      }
    } },
  { id: 'quick-open-keyboard', goal: 'Ctrl+Pの直後、入力欄をクリックせずファイル名を打てる',
    steps: ['notes.txt の本文へフォーカス', 'Ctrl+P', 'そのまま notes と入力'],
    run: async (p) => {
      await quickOpen(p);
      await p.locator('.monaco-editor:visible .view-lines').first().click();
      await p.keyboard.press('Control+p');
      await p.getByRole('dialog', { name: 'ファイル名で開く' }).waitFor();
      await p.keyboard.type('notes', { delay: 60 });
      if (await p.getByLabel('開くファイルの名前', { exact: true }).inputValue() !== 'notes') throw new Error('Ctrl+P直後の文字がファイル名入力欄に届かない');
    } },
  { id: 'edit-save', goal: '編集を保存し、閉じて開き直したときも内容が残る',
    steps: ['notes.txt を開く', '本文をクリックして編集', 'Ctrl+S', '閉じて開き直す'],
    run: async (p) => {
      await quickOpen(p);
      await p.locator('.monaco-editor:visible .view-lines').first().click();
      await p.keyboard.press('Control+End'); await p.keyboard.type('saved-check', { delay: 60 });
      await p.keyboard.press('Control+s');
      await p.getByText(/✔ 保存しました/).waitFor();
      await p.keyboard.press('Control+w');
      await quickOpen(p);
      await waitFor(async () => (await p.locator('.monaco-editor:visible .view-lines').innerText()).includes('saved-check'), '保存した内容が再度開いた画面に表示されない');
    } },
  { id: 'dirty-close', goal: '未保存ファイルを閉じるのを取り消して、編集を続ける',
    steps: ['notes.txt を編集', 'Ctrl+W', '破棄確認をキャンセル', '未保存表示を確認'],
    run: async (p) => {
      await quickOpen(p);
      await p.locator('.monaco-editor:visible .view-lines').first().click();
      await p.keyboard.type('keep-check', { delay: 60 });
      await p.getByText('● 未保存', { exact: true }).waitFor();
      let asked = false;
      p.once('dialog', async (dialog) => { asked = dialog.type() === 'confirm'; await dialog.dismiss(); });
      await p.keyboard.press('Control+w');
      if (!asked) throw new Error('未保存変更の破棄確認がなかった');
      await p.getByText('● 未保存', { exact: true }).waitFor();
    } },
];

async function launch(): Promise<Browser> {
  const errors: string[] = [];
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { return await chromium.launch({ channel, headless: !headed }); }
    catch (e) { errors.push(String(e)); }
  }
  throw new Error(`Edge / Chrome / Playwright Chromium が必要です。\n${errors.join('\n')}`);
}
async function main() {
  if (only.some((id) => !journeys.some((j) => j.id === id))) throw new Error(`--only は ${journeys.map((j) => j.id).join(', ')} から指定してください`);
  await fs.mkdir(out, { recursive: true });
  const browser = await launch();
  if (args.includes('--explore')) {
    const steps = Number(arg('--steps', '12'));
    if (!Number.isInteger(steps) || steps < 1 || steps > 50) { await browser.close(); throw new Error('--steps は1から50の整数です'); }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    await installFixture(context);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      await page.goto(url);
      await page.getByRole('navigation', { name: '中央の表示' }).getByRole('button', { name: /^開いたファイル/ }).click();
      await page.getByRole('button', { name: 'notes.txt', exact: true }).waitFor();
      const { explore } = await import('./browser-explore.ts');
      await explore(page, out, arg('--model', 'haiku'), steps,
        arg('--goal', 'メモの中の apple を探して、そのファイルを開き、末尾に買い物の予定を書いて保存する。途中で名前によるファイル検索や表示の切替を試し、迷った点や入力しづらい点を報告する。'));
    } finally {
      await context.tracing.stop({ path: path.join(out, 'trace.zip') });
      await browser.close();
    }
    console.log(`自由探索レポート: ${path.join(out, 'report.md')}`);
    return;
  }
  const results: { id: string; goal: string; steps: string[]; ok: boolean; error: string; durationMs: number; screenshot: string; snapshot: string; trace: string }[] = [];
  try {
    for (const journey of journeys.filter((j) => !only.length || only.includes(j.id))) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', reducedMotion: 'reduce', serviceWorkers: 'block' });
      const fixture = await installFixture(context);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
      const started = Date.now(); let error = '';
      try {
        await page.goto(url);
        await page.getByRole('navigation', { name: '中央の表示' }).getByRole('button', { name: /^開いたファイル/ }).click();
        await page.getByRole('button', { name: 'notes.txt', exact: true }).waitFor();
        await journey.run(page, fixture);
        if (errors.length) throw new Error(`画面エラー: ${errors.join('; ')}`);
        if (fixture.unexpected.length) throw new Error(`検証環境の未対応API: ${fixture.unexpected.join('; ')}`);
      } catch (e) { error = e instanceof Error ? e.message : String(e); }
      const screenshot = `${journey.id}.png`, snapshot = `${journey.id}.yml`, trace = `${journey.id}.zip`;
      await page.screenshot({ path: path.join(out, screenshot), fullPage: true });
      await fs.writeFile(path.join(out, snapshot), await page.locator('body').ariaSnapshot());
      await context.tracing.stop({ path: path.join(out, trace) });
      results.push({ id: journey.id, goal: journey.goal, steps: journey.steps, ok: !error, error, durationMs: Date.now() - started, screenshot, snapshot, trace });
      console.log(`${error ? 'FAIL' : 'PASS'} ${journey.id}${error ? `: ${error.split('\n')[0]}` : ''}`);
      await context.close();
    }
  } finally { await browser.close(); }
  const failed = results.filter((r) => !r.ok).length;
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ runId, url, mode: 'isolated-browser-journeys', results }, null, 2));
  await fs.writeFile(path.join(out, 'report.md'), [
    '# エディター利用者役エージェントの操作記録', '',
    `${runId} / ${url}`, '', `${results.length} 件中 ${results.length - failed} 件成功・${failed} 件要確認。`, '',
    '実際の React / Monaco 画面をクリック・入力・キー操作で確認。バックエンドのみメモリ上の検証用データに置換。実サーバーの保存・検索実装や、自由探索による未知の問題の網羅を保証するものではありません。', '',
    ...results.flatMap((r) => [`## ${r.ok ? 'PASS' : 'FAIL'} ${r.id}`, '', r.goal, '', ...r.steps.map((s, i) => `${i + 1}. ${s}`), '', r.error ? `不満・失敗: ${r.error}` : '期待した操作が完了しました。', '', `[画面](${r.screenshot}) / [画面の読み取り](${r.snapshot}) / [操作トレース](${r.trace})`, '']),
  ].join('\n'));
  console.log(`レポート: ${path.join(out, 'report.md')}`);
  if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
