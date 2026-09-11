// Tower のデスクトップ版（Electron）。
// - サーバー（4800）が動いていなければ起動する（動いていればそれを使う）
// - 画面はサーバーが配信する apps/web/dist（無ければ Vite の 5173）を読む
// - 閉じるボタンはトレイに隠すだけ。トレイのメニューから「終了」で本当に終わる
// - 通知は画面側（Web の Notification API）がそのまま Windows の通知になる（AppUserModelId が要る）
const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.TOWER_PORT ?? 4800);
const SMOKE = process.env.TOWER_DESKTOP_SMOKE === '1';

let win = null;
let tray = null;
let serverProc = null;
let quitting = false;

app.setAppUserModelId('jp.shakeailab.tower');

function up(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** サーバーが無ければ起動して、応答するまで待つ */
async function ensureServer() {
  const health = `http://127.0.0.1:${PORT}/api/health`;
  if (await up(health)) return 'external';
  serverProc = spawn('node', [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'apps/server/src/index.ts')], {
    cwd: ROOT,
    shell: process.platform === 'win32',
    stdio: 'inherit',
    env: { ...process.env },
  });
  for (let i = 0; i < 120; i++) {
    if (await up(health)) return 'spawned';
    await sleep(500);
  }
  throw new Error('Tower のサーバーが起動しませんでした');
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/** 開発中は Vite（5173）が動いていればそちら、無ければサーバーが配信するビルド済み画面 */
async function pickUrl() {
  if (await up('http://localhost:5173/')) return 'http://localhost:5173/';
  return `http://127.0.0.1:${PORT}/`;
}

function show() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Tower',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true },
  });
  win.loadURL(url);
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  // 外部リンクは既定のブラウザで
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u) && !u.startsWith(`http://127.0.0.1:${PORT}`) && !u.startsWith('http://localhost:5173')) shell.openExternal(u);
    return { action: 'deny' };
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')));
  tray.setToolTip('Tower');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '開く', click: show },
      { type: 'separator' },
      {
        label: '終了',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', show);
}

/** 判断待ちの件数をトレイのツールチップに出す（サーバーの WebSocket を購読） */
function watchSessions() {
  let WebSocket;
  try {
    WebSocket = require('ws');
  } catch {
    return;
  }
  const sessions = new Map();
  const refresh = () => {
    const waiting = [...sessions.values()].filter((s) => s.pending).length;
    tray?.setToolTip(waiting ? `Tower — 判断待ち ${waiting} 件` : 'Tower');
  };
  const connect = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('message', (data) => {
      try {
        const ev = JSON.parse(String(data));
        if (ev.type === 'snapshot') {
          sessions.clear();
          for (const s of ev.sessions) sessions.set(s.id, s);
        } else if (ev.type === 'session') sessions.set(ev.session.id, ev.session);
        else if (ev.type === 'session_removed') sessions.delete(ev.id);
        refresh();
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => {
      if (!quitting) setTimeout(connect, 3000);
    });
    ws.on('error', () => {});
  };
  connect();
}

app.whenReady().then(async () => {
  try {
    const mode = await ensureServer();
    const url = await pickUrl();
    createTray();
    createWindow(url);
    watchSessions();
    if (SMOKE) {
      setTimeout(() => {
        console.log(`[smoke] server=${mode} url=${url} window=${win?.isVisible()} title=${win?.getTitle()}`);
        quitting = true;
        app.quit();
      }, 6000);
    }
  } catch (e) {
    console.error(e);
    quitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
  if (serverProc) killTree(serverProc);
});

// 全部の窓を閉じてもトレイに残る
app.on('window-all-closed', () => {});
app.on('activate', show);
