// Tower が Codex に渡すブラウザー（app-server の dynamicTools）。
// Codex アプリの内蔵ブラウザーは VS Code / Codex アプリの画面の中にあるもので、Tower からは借りられない。
// そこで Tower が入っている Edge / Chrome を playwright-core で動かし、「開く・見る・押す・入力する」を道具として渡す。
// 撮った画面は画像のまま Codex に返し、年表にも残す（利用者も AI と同じものを見られる）
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { SHOTS_DIR, launch } from '../preview.ts';

export interface DynamicToolSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolContent = { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string };

export interface ToolResult {
  contentItems: ToolContent[];
  success: boolean;
  /** 年表に出す一言 */
  label: string;
  /** 撮った画面（年表に添える） */
  shot?: string;
}

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): DynamicToolSpec => ({
  type: 'function',
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

const TARGET = {
  selector: { type: 'string', description: 'CSS or Playwright selector, e.g. #save, text=Save, role=button[name="Save"]' },
  text: { type: 'string', description: 'visible text of the element' },
  x: { type: 'number', description: 'viewport x in the last screenshot' },
  y: { type: 'number', description: 'viewport y in the last screenshot' },
};

// 道具の説明は AI が読むもの（利用者には出さない）
export const BROWSER_TOOLS: DynamicToolSpec[] = [
  tool(
    'tower_browser_open',
    "Open a URL in Tower's browser (a headless Microsoft Edge / Chrome run by Tower, separate from the user's browser) and get back a screenshot, the title, visible text and console errors. Use it to look at and verify web pages you build or fix, e.g. http://127.0.0.1:5000/ . Start the dev server yourself first if needed.",
    {
      url: { type: 'string', description: 'http://, https:// or file:// URL' },
      width: { type: 'integer', description: 'viewport width (default 1280)' },
      height: { type: 'integer', description: 'viewport height (default 800)' },
    },
    ['url'],
  ),
  tool('tower_browser_screenshot', 'Take a new screenshot of the current page. fullPage=true captures the whole scrollable page (up to 6000px tall).', { fullPage: { type: 'boolean' } }),
  tool('tower_browser_click', 'Click an element found by selector, by visible text, or at viewport coordinates x/y. Returns a screenshot afterwards.', {
    ...TARGET,
    double: { type: 'boolean', description: 'double click' },
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
  }),
  tool('tower_browser_hover', 'Move the mouse over an element (selector / text / x,y). Returns a screenshot.', TARGET),
  tool(
    'tower_browser_type',
    'Type text. With selector, replaces the value of that input/textarea; without, types into the focused element. pressEnter=true presses Enter afterwards. Returns a screenshot.',
    { selector: { type: 'string' }, text: { type: 'string' }, pressEnter: { type: 'boolean' } },
    ['text'],
  ),
  tool('tower_browser_press', 'Press a key or a combination such as Enter, Escape, Tab, ArrowDown, Control+S. Returns a screenshot.', { key: { type: 'string' } }, ['key']),
  tool('tower_browser_scroll', 'Scroll by deltaY (down is positive) / deltaX pixels, over the element at x,y if given. Returns a screenshot.', {
    deltaY: { type: 'number' },
    deltaX: { type: 'number' },
    x: { type: 'number' },
    y: { type: 'number' },
  }),
  tool(
    'tower_browser_evaluate',
    'Evaluate JavaScript in the page and return the result as JSON (an expression such as document.title, or an arrow function which is called). Use it to read DOM state, computed styles, localStorage and so on.',
    { expression: { type: 'string' } },
    ['expression'],
  ),
  tool('tower_browser_resize', 'Resize the viewport, e.g. 390x844 to check a phone layout. Returns a screenshot.', { width: { type: 'integer' }, height: { type: 'integer' } }, ['width', 'height']),
  tool('tower_browser_back', 'Go back to the previous page. Returns a screenshot.', {}),
  tool('tower_browser_close', "Close Tower's browser when you are done.", {}),
];

export const isBrowserTool = (name: string): boolean => BROWSER_TOOLS.some((t) => t.name === name);

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const short = (s: string, n = 50) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 失敗の理由を年表向けの日本語に（英語の原文は Codex に返し、年表の詳細にも残す） */
export function failureReason(msg: string): string {
  if (/Timeout .*exceeded/i.test(msg)) return '押す場所が見つからないか、操作できる状態になりませんでした';
  if (/net::ERR_|ECONNREFUSED/i.test(msg)) return 'ページを開けませんでした（サーバーが動いていない・アドレスの間違い など）';
  if (/No page is open/i.test(msg)) return 'まだページを開いていません';
  if (/Edge|Chrome|launch/i.test(msg)) return 'ブラウザー（Edge / Chrome）を起動できませんでした';
  return 'うまくいきませんでした';
}

/** 道具の呼び出し → 「今やっていること」 */
export function browserActivity(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'tower_browser_open':
      return `ブラウザーで開いています（${short(String(args.url ?? ''))}）`;
    case 'tower_browser_click':
      return 'ブラウザーでクリックしています';
    case 'tower_browser_type':
      return 'ブラウザーで入力しています';
    case 'tower_browser_evaluate':
      return 'ページの中身を調べています';
    default:
      return 'ブラウザーで画面を確かめています';
  }
}

/** Codex への注意書き（会話の最初に開発者向けの指示として渡す） */
export function browserNote(previewTarget?: string): string {
  return [
    '# 画面の確認（Tower のブラウザー）',
    'Tower が `tower_browser_*` という道具を用意しています。Web ページを開いてスクリーンショットを見たり、クリック・入力・スクロール・キー操作・JavaScript で中身を確かめたりできます（Tower が動かす Edge / Chrome で、利用者のブラウザーとは別です）。撮った画面は利用者にも見えます。',
    '- 画面を作ったり直したりしたら、報告の前にこの道具で開いて自分の目で確かめる。確かめた内容は【報告】の「やったこと」に書く',
    '- 開発サーバーが要る時は、自分で起動してから開く',
    '- 利用者に「ブラウザーで開いて確認してください」「画面の画像を送ってください」と頼まない',
    '- この環境では Codex アプリの内蔵ブラウザーは使えない。利用者がふだん使っている Chrome を操作する必要がある時だけ、Chrome 拡張を使うブラウザー操作を試す',
    ...(previewTarget ? [`- Tower も作業の前後と報告のたびに ${previewTarget} のスクリーンショットを自動で撮り、利用者に見せる`] : []),
  ].join('\n');
}

/** 1 セッションに 1 つ。最初に開いた時にブラウザーを起動し、止めた時に閉じる */
export class TowerBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private problems: string[] = [];
  private viewport = { width: 1280, height: 800 };

  constructor(private sessionId: string) {}

  /** 失敗しても投げない（Codex には失敗の理由を返して、別のやり方を考えてもらう） */
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await this.run(name, args);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      return { success: false, label: `ブラウザー操作に失敗: ${failureReason(msg)}`, contentItems: [{ type: 'inputText', text: `Error: ${msg}` }] };
    }
  }

  async close() {
    const b = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    await b?.close().catch(() => {});
  }

  private async run(name: string, a: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'tower_browser_open': {
        const url = String(a.url ?? '').trim();
        if (!/^(https?|file):/i.test(url) && url !== 'about:blank') throw new Error('url must start with http://, https:// or file://');
        if (num(a.width) && num(a.height)) this.viewport = { width: Math.round(a.width), height: Math.round(a.height) };
        const page = await this.ensurePage();
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await this.settle(page);
        return this.snapshot(`ブラウザーで開きました（${short(url)}）`, res ? `HTTP status: ${res.status()}` : '');
      }
      case 'tower_browser_screenshot':
        return this.snapshot('画面を撮りました', '', a.fullPage === true);
      case 'tower_browser_click': {
        const page = this.current();
        const t = this.target(page, a);
        const opts = { button: (a.button as 'left' | 'right' | 'middle' | undefined) ?? 'left', clickCount: a.double === true ? 2 : 1 };
        if ('x' in t) await page.mouse.click(t.x, t.y, opts);
        else await t.loc.click({ ...opts, timeout: 10_000 });
        await this.settle(page);
        return this.snapshot(`クリックしました（${t.desc}）`);
      }
      case 'tower_browser_hover': {
        const page = this.current();
        const t = this.target(page, a);
        if ('x' in t) await page.mouse.move(t.x, t.y);
        else await t.loc.hover({ timeout: 10_000 });
        await page.waitForTimeout(300);
        return this.snapshot(`マウスを重ねました（${t.desc}）`);
      }
      case 'tower_browser_type': {
        const page = this.current();
        const text = String(a.text ?? '');
        if (typeof a.selector === 'string' && a.selector) await page.locator(a.selector).first().fill(text, { timeout: 10_000 });
        else await page.keyboard.type(text);
        if (a.pressEnter === true) await page.keyboard.press('Enter');
        await this.settle(page);
        return this.snapshot(`入力しました（${short(text, 30)}）`);
      }
      case 'tower_browser_press': {
        const page = this.current();
        const key = String(a.key ?? '');
        await page.keyboard.press(key);
        await this.settle(page);
        return this.snapshot(`キーを押しました（${key}）`);
      }
      case 'tower_browser_scroll': {
        const page = this.current();
        if (num(a.x) && num(a.y)) await page.mouse.move(a.x, a.y);
        await page.mouse.wheel(num(a.deltaX) ? a.deltaX : 0, num(a.deltaY) ? a.deltaY : 0);
        await page.waitForTimeout(400);
        return this.snapshot('スクロールしました');
      }
      case 'tower_browser_evaluate': {
        const page = this.current();
        let expr = String(a.expression ?? '');
        // 関数の形で渡されたら呼んだ結果を返す
        if (/^\s*(async\s+)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(expr)) expr = `(${expr})()`;
        const value: unknown = await page.evaluate(expr);
        let text: string;
        try {
          text = JSON.stringify(value, null, 2) ?? 'undefined';
        } catch {
          text = String(value);
        }
        return { success: true, label: 'ページの中身を調べました', contentItems: [{ type: 'inputText', text: short(text, 8000) }] };
      }
      case 'tower_browser_resize': {
        const page = this.current();
        if (!num(a.width) || !num(a.height)) throw new Error('width and height are required');
        this.viewport = { width: Math.round(a.width), height: Math.round(a.height) };
        await page.setViewportSize(this.viewport);
        await page.waitForTimeout(300);
        return this.snapshot(`画面の大きさを ${this.viewport.width}×${this.viewport.height} にしました`);
      }
      case 'tower_browser_back': {
        const page = this.current();
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
        await this.settle(page);
        return this.snapshot('前のページに戻りました');
      }
      case 'tower_browser_close':
        await this.close();
        return { success: true, label: 'ブラウザーを閉じました', contentItems: [{ type: 'inputText', text: 'closed' }] };
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      await this.page.setViewportSize(this.viewport);
      return this.page;
    }
    if (!this.browser?.isConnected()) this.browser = await launch();
    this.context = await this.browser.newContext({ viewport: this.viewport });
    const page = await this.context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') this.problem(`console.${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => this.problem(`page error: ${e.message}`));
    page.on('requestfailed', (r) => this.problem(`request failed: ${r.url()} (${r.failure()?.errorText ?? ''})`));
    this.page = page;
    return page;
  }

  private current(): Page {
    if (!this.page || this.page.isClosed()) throw new Error('No page is open. Call tower_browser_open first.');
    return this.page;
  }

  private target(page: Page, a: Record<string, unknown>): { loc: Locator; desc: string } | { x: number; y: number; desc: string } {
    if (typeof a.selector === 'string' && a.selector) return { loc: page.locator(a.selector).first(), desc: short(a.selector, 40) };
    if (typeof a.text === 'string' && a.text) return { loc: page.getByText(a.text).first(), desc: `「${short(a.text, 30)}」` };
    if (num(a.x) && num(a.y)) return { x: a.x, y: a.y, desc: `${Math.round(a.x)}, ${Math.round(a.y)}` };
    throw new Error('selector, text or x/y is required');
  }

  /** 読み込みと描画が落ち着くのを少し待つ */
  private async settle(page: Page) {
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(250);
  }

  private problem(s: string) {
    this.problems.push(short(s, 300));
    if (this.problems.length > 50) this.problems.shift();
  }

  /** 撮って、Codex に返す形（文 + 画像）にする。画像は年表用にも保存する */
  private async snapshot(label: string, extra = '', fullPage = false): Promise<ToolResult> {
    const page = this.current();
    const dir = path.join(SHOTS_DIR, this.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `browser-${Date.now()}.jpg`);
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (fullPage) {
      const h = Number(await page.evaluate('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)').catch(() => 0));
      if (h > 6000) clip = { x: 0, y: 0, width: this.viewport.width, height: 6000 };
    }
    const buf = await page.screenshot({ path: file, type: 'jpeg', quality: 80, fullPage, ...(clip ? { clip } : {}) });
    const title = await page.title().catch(() => '');
    const text = String(
      await page.evaluate("(document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 3000)").catch(() => ''),
    );
    const problems = this.problems.splice(0);
    const info = [
      `URL: ${page.url()}`,
      title ? `Title: ${title}` : '',
      extra,
      `Viewport: ${this.viewport.width}x${this.viewport.height}`,
      problems.length ? `Console / network problems since the last step:\n${problems.slice(-15).join('\n')}` : 'Console errors: none',
      `Visible text (first 3000 chars):\n${text}`,
    ]
      .filter(Boolean)
      .join('\n');
    return {
      success: true,
      label,
      shot: file,
      contentItems: [
        { type: 'inputText', text: info },
        { type: 'inputImage', imageUrl: `data:image/jpeg;base64,${buf.toString('base64')}` },
      ],
    };
  }
}
