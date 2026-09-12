// 見た目の確認: サイトのスクリーンショットを Tower が撮って報告に添える（「ブラウザで確認してください」を減らす）。
// PC に入っている Edge / Chrome を playwright-core から起動するので、ブラウザのダウンロードは要らない。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import type { Screenshot } from '@tower/shared';
import { DATA_DIR } from './config.ts';
import { readJson } from './verify.ts';

export const SHOTS_DIR = path.join(DATA_DIR, 'shots');

export type PreviewTarget =
  | { kind: 'static'; dir: string }
  | {
      kind: 'url';
      url: string;
      /** 開発サーバーの起動コマンド（URL に繋がらない時だけ Tower が起動し、撮ったら止める） */
      command?: string;
      /** 起動を待つ秒数（既定 60） */
      readySeconds?: number;
    };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 何を撮るか。.tower.json の "preview" があればそれ（null なら撮らない）:
 *   "preview": "http://localhost:3000"
 *   "preview": { "url": "http://localhost:3000", "command": "npm run dev", "readySeconds": 60 }
 * 無ければ、フォルダ直下に index.html があれば Tower が静的に配信して撮る。どちらも無ければ null
 */
export function detectPreview(dir: string): PreviewTarget | null {
  const local = readJson(path.join(dir, '.tower.json'));
  if (local && 'preview' in local) {
    const p = local.preview as unknown;
    if (typeof p === 'string' && /^https?:\/\//.test(p)) return { kind: 'url', url: p };
    if (p && typeof p === 'object') {
      const o = p as { url?: unknown; command?: unknown; readySeconds?: unknown };
      if (typeof o.url === 'string' && /^https?:\/\//.test(o.url)) {
        return {
          kind: 'url',
          url: o.url,
          command: typeof o.command === 'string' && o.command.trim() ? o.command.trim() : undefined,
          readySeconds: typeof o.readySeconds === 'number' && o.readySeconds > 0 ? o.readySeconds : undefined,
        };
      }
    }
    return null;
  }
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) return null;
  if (!isDevEntry(dir, index)) return { kind: 'static', dir };
  // Vite などの開発用の入口（<script type="module" src="/src/main.tsx">）は、ファイルのまま配っても真っ白になる。
  // 組み立て済み（dist/ など）があればそれを撮り、無ければ手元の vite で開発サーバーを立てて撮る。どちらも無ければ撮らない
  for (const out of ['dist', 'build']) {
    if (fs.existsSync(path.join(dir, out, 'index.html'))) return { kind: 'static', dir: path.join(dir, out) };
  }
  return viteServer(dir);
}

/**
 * 今は撮れないが、依存パッケージを入れる・組み立てると撮れるページ（開発用の入口の index.html）なら、その呼び名。
 * 作業の最初に「撮る予定」として扱い、エージェントに「Tower が撮るので自分でブラウザを入れない」と伝える（修正後は報告の時に撮り直す）
 */
export function laterPreviewLabel(dir: string): string | null {
  const index = path.join(dir, 'index.html');
  return fs.existsSync(index) && isDevEntry(dir, index) ? 'index.html（依存パッケージが入ると撮れる開発用のページ）' : null;
}

/** index.html が開発用の入口か: ソースの .ts / .tsx / .jsx を module で直接読む、または vite の設定があって /src/ を読む */
function isDevEntry(dir: string, index: string): boolean {
  let html = '';
  try {
    html = fs.readFileSync(index, 'utf8');
  } catch {
    return false;
  }
  const hasVite = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'].some((f) => fs.existsSync(path.join(dir, f)));
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/type=["']module["']/i.test(tag)) continue;
    const src = tag.match(/src=["']([^"']+)["']/i)?.[1] ?? '';
    if (/\.(?:tsx?|jsx|mts)$/i.test(src) || (hasVite && /^\/?src\//.test(src))) return true;
  }
  return false;
}

/** 手元に vite があれば、フォルダごとに決まる番号で開発サーバーを立てる（撮り終わったら止める）。無ければ撮らない */
function viteServer(dir: string): PreviewTarget | null {
  const bin = path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
  if (!fs.existsSync(bin)) return null;
  let h = 0;
  for (const c of path.resolve(dir)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const port = 5300 + (h % 600);
  return { kind: 'url', url: `http://127.0.0.1:${port}/`, command: `"${bin}" --host 127.0.0.1 --port ${port} --strictPort`, readySeconds: 60 };
}

export const targetLabel = (t: PreviewTarget): string => (t.kind === 'url' ? t.url : 'index.html');

/** ダークモード対応のサイトか（CSS / HTML に prefers-color-scheme か color-scheme があればダークも撮る） */
export function wantsDark(dir: string, depth = 2): boolean {
  const re = /prefers-color-scheme|color-scheme/;
  const walk = (d: string, level: number): boolean => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (level < depth && walk(p, level + 1)) return true;
      } else if (/\.(css|html?)$/i.test(e.name)) {
        try {
          const st = fs.statSync(p);
          if (st.size > 512 * 1024) continue;
          if (re.test(fs.readFileSync(p, 'utf8'))) return true;
        } catch {
          /* skip */
        }
      }
    }
    return false;
  };
  return walk(dir, 0);
}

/** フォルダを 127.0.0.1 の空きポートで静的に配信する（撮影の間だけ） */
function serveStatic(dir: string): Promise<{ url: string; close: () => void }> {
  const base = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let raw = '/';
    try {
      raw = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      /* 変な URL */
    }
    let file = path.resolve(base, `.${raw}`);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      /* 無い → 404 */
    }
    fs.readFile(file, (e, data) => {
      if (e) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

/** URL が応答するか（何かしらの HTTP 応答があれば「起動している」とみなす） */
async function isUp(url: string, timeoutMs = 1500): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await fetch(url, { signal: ac.signal, redirect: 'manual' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 子プロセスをぶら下がりごと止める（Windows は taskkill /T、他は プロセスグループ） */
function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

/**
 * 開発サーバーが起動していなければ command で起動して、URL が応答するまで待つ。
 * 起動したのが Tower なら、撮り終わった後に止めるための stop を返す（元から動いていたなら null）
 */
async function ensureServer(target: Extract<PreviewTarget, { kind: 'url' }>, dir: string): Promise<(() => void) | null> {
  if (await isUp(target.url)) return null;
  if (!target.command) {
    throw new Error(`${target.url} に繋がりません（開発サーバーは起動していますか？ .tower.json の preview に "command" を書けば Tower が起動します）`);
  }
  const tail: string[] = [];
  const child = spawn(target.command, {
    cwd: dir,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none', CI: '1', FORCE_COLOR: '0' },
  });
  const keep = (d: Buffer) => {
    tail.push(d.toString());
    while (tail.length > 40) tail.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? -1));
  const stop = () => killTree(child);
  const deadline = Date.now() + (target.readySeconds ?? 60) * 1000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`開発サーバー「${target.command}」がすぐ終了しました（終了コード ${exited}）:\n${tail.join('').trim().slice(-600)}`);
    }
    if (await isUp(target.url)) return stop;
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(`開発サーバー「${target.command}」を起動しましたが、${target.readySeconds ?? 60} 秒たっても ${target.url} が応答しません:\n${tail.join('').trim().slice(-600)}`);
}

async function launch(): Promise<Browser> {
  let lastErr = '';
  for (const channel of ['msedge', 'chrome'] as const) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (e) {
      lastErr = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    }
  }
  throw new Error(`ブラウザ（Edge / Chrome）を起動できませんでした: ${lastErr}`);
}

/** PNG のヘッダから幅と高さ */
function pngSize(file: string): { width: number; height: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 撮る。ライト（ダーク対応サイトならダークも）。~/.tower/shots/<sessionId>/ に保存して一覧を返す。
 * @param label 'before'（修正前）| 'after'（修正後）
 */
export async function capture(sessionId: string, dir: string, target: PreviewTarget, label: string): Promise<Screenshot[]> {
  const outDir = path.join(SHOTS_DIR, sessionId);
  fs.mkdirSync(outDir, { recursive: true });
  const served = target.kind === 'static' ? await serveStatic(target.dir) : null;
  const url = target.kind === 'url' ? target.url : served!.url;
  const schemes: ('light' | 'dark')[] = wantsDark(dir) ? ['light', 'dark'] : ['light'];
  const shots: Screenshot[] = [];
  const at = Date.now();
  let browser: Browser | null = null;
  let stopServer: (() => void) | null = null;
  try {
    if (target.kind === 'url') stopServer = await ensureServer(target, dir);
    browser = await launch();
    for (const scheme of schemes) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, colorScheme: scheme });
      try {
        try {
          await page.goto(url, { waitUntil: 'load', timeout: 15_000 });
        } catch (e) {
          const why = (e instanceof Error ? e.message : String(e)).split('\n')[0];
          throw new Error(target.kind === 'url' ? `${url} を開けませんでした: ${why}` : `ページを開けませんでした: ${why}`);
        }
        await page.waitForTimeout(300); // フォントや遅延描画を少し待つ
        // 何も描かれないページ（開発用の入口をそのまま開いた等）は、真っ白な写真を見せずに理由を出す
        // ブラウザの中で評価する式（サーバー側の型には document が無いので文字列で渡す）
        const drawn = await page
          .waitForFunction(
            "!!document.body && (document.body.innerText.trim().length > 0 || !!document.body.querySelector('img,svg,canvas,video,iframe,input,button,textarea,select'))",
            undefined,
            { timeout: 3000 },
          )
          .then(
            () => true,
            () => false,
          );
        if (!drawn) {
          throw new Error('ページに何も表示されませんでした（真っ白）。開発サーバーで動くページなら、.tower.json の preview に URL と command を書くと撮れます');
        }
        const file = `${label}-${scheme}-${at}.png`;
        const full = path.join(outDir, file);
        await page.screenshot({ path: full, fullPage: true });
        const { width, height } = pngSize(full);
        shots.push({ label, scheme, file, url: `/api/sessions/${sessionId}/shots/${file}`, at, width, height });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    served?.close();
    stopServer?.();
  }
  return shots;
}

/** エージェントへの注意書き（システムプロンプトに追記） */
export function previewNote(target: string): string {
  return [
    '# 見た目の確認について',
    `Tower が作業の前後でサイト（${target}）のスクリーンショットを自動で撮り（ダーク対応ならライト/ダーク両方）、利用者に見せます。`,
    '- あなたがブラウザを開いたり、開発サーバーを立てたり、スクリーンショットを撮る道具（Playwright 等）を入れたりする必要はありません',
    '- 見た目の確認が依頼に含まれていて自分では確かめられない時は、「結果」を一部完了にして、「判断が必要」に「添付のスクリーンショットで見た目を確認してください」と書く',
    '- 「ブラウザで http://localhost:… を開いて確認してください」のような、利用者にブラウザ操作を頼む案内は書かない（利用者は Tower の画面のスクリーンショットで見る）',
  ].join('\n');
}
