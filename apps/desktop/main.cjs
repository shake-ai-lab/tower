// Tower のデスクトップ版（Electron）。
// - サーバー（4800）が動いていなければ起動する（動いていればそれを使う）
// - 画面はサーバーが配信する apps/web/dist（無ければ Vite の 5173）を読む
// - 閉じるボタンはトレイに隠すだけ。トレイのメニューから「終了」で本当に終わる
// - 通知は画面側（Web の Notification API）がそのまま Windows の通知になる（AppUserModelId が要る）
const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
/** サーバーと同じ設定（~/.tower/config.json）のポートを見る。画面の設定でポートを変えても次回ちゃんと開けるように */
function configuredPort() {
  try {
    const p = Number(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.tower', 'config.json'), 'utf8')).port);
    if (p > 0) return p;
  } catch {
    /* 設定が無い・壊れている: 既定 */
  }
  return 4800;
}
const PORT = Number(process.env.TOWER_PORT) > 0 ? Number(process.env.TOWER_PORT) : configuredPort();
const SMOKE = process.env.TOWER_DESKTOP_SMOKE === '1';
// サインイン時の自動起動（--hidden）では窓を出さずトレイだけにする
const HIDDEN = process.argv.includes('--hidden');
const LOGIN_ARGS = ['--hidden'];
// インストーラ版（build.mjs）では、束ねたサーバーと画面が main.cjs の隣に置かれる
const BUNDLED_SERVER = path.join(__dirname, 'app', 'server.mjs');
const BUNDLED = fs.existsSync(BUNDLED_SERVER);

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

// ---- サーバーの記録と、落ちた時の立て直し ----
// 以前は止まった理由が窓に一度出るだけで、どこにも残らなかった。サーバーの出力は ~/.tower/server.log に残す（5MB で 1 世代だけ回す）
const DATA_DIR = process.env.TOWER_DATA_DIR ? path.resolve(process.env.TOWER_DATA_DIR) : path.join(os.homedir(), '.tower');
const SERVER_LOG = path.join(DATA_DIR, 'server.log');

function openServerLog() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SERVER_LOG) && fs.statSync(SERVER_LOG).size > 5 * 1024 * 1024) fs.renameSync(SERVER_LOG, `${SERVER_LOG}.1`);
    const stream = fs.createWriteStream(SERVER_LOG, { flags: 'a' });
    stream.on('error', () => {});
    stream.write(`\n==== ${new Date().toLocaleString('ja-JP')} サーバーを起動 ====\n`);
    return stream;
  } catch {
    return null;
  }
}

/** 思いがけず止まった時に起動し直した時刻（短い間に何度も落ちる時は、繰り返さずに知らせる） */
const restarts = [];
const RESTART_LIMIT = 3;
const RESTART_WINDOW_MS = 10 * 60_000;

/** サーバーが無ければ起動して、応答するまで待つ */
async function ensureServer() {
  const health = `http://127.0.0.1:${PORT}/api/health`;
  if (await up(health)) return 'external';
  // shell は使わない（使うと引用符無しで連結され、パスに空白があると起動できない）
  const nodeCheck = spawnSync('node', ['--version'], { encoding: 'utf8' });
  const ver = (nodeCheck.stdout ?? '').trim();
  const [major, minor] = ver.replace(/^v/, '').split('.').map(Number);
  if (nodeCheck.status !== 0 || !(major > 22 || (major === 22 && minor >= 13))) {
    throw new Error(
      `Tower のサーバーを動かすには Node.js 22.13 以上が必要です（見つかったもの: ${ver || '無し'}）。https://nodejs.org/ から入れてから、もう一度開いてください`,
    );
  }
  const args = BUNDLED
    ? [BUNDLED_SERVER]
    : [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'apps/server/src/index.ts')];
  const env = { ...process.env };
  // こちらが待つポートとサーバーが開くポートを必ず一致させる
  env.TOWER_PORT = String(PORT);
  if (BUNDLED) {
    env.TOWER_WEB_DIST = path.join(__dirname, 'web');
    env.TOWER_HOOK_SCRIPT = path.join(__dirname, 'app', 'hooks', 'tower-hook.mjs');
  }
  const child = spawn('node', args, {
    cwd: BUNDLED ? __dirname : ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  serverProc = child;
  const log = openServerLog();
  child.stdout?.on('data', (d) => {
    process.stdout.write(d);
    log?.write(d);
  });
  // すぐ落ちた時に 60 秒待たずに理由を出せるよう、終了と stderr の末尾を覚えておく
  const tail = [];
  child.stderr?.on('data', (d) => {
    process.stderr.write(d);
    log?.write(d);
    tail.push(String(d));
    while (tail.length > 30) tail.shift();
  });
  let started = false;
  let exited = null;
  child.once('error', (e) => { exited = { error: e.message }; });
  child.once('exit', (code, signal) => {
    exited = { code, signal };
    log?.end(`==== ${new Date().toLocaleString('ja-JP')} サーバーが止まりました（終了コード ${code ?? signal ?? '?'}） ====\n`);
    if (serverProc === child) serverProc = null;
    if (quitting || !started || SMOKE) return;
    // 思いがけず止まった: 自動で起動し直す（画面はつなぎ直し、作業中だったタスクは自動再開の対象になる）。短い間に何度も落ちる時だけ知らせる
    const now = Date.now();
    while (restarts.length && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length < RESTART_LIMIT) {
      restarts.push(now);
      ensureServer().catch((e) => {
        dialog.showErrorBox('Tower のサーバーを起動し直せませんでした', `${e instanceof Error ? e.message : String(e)}\n\n記録: ${SERVER_LOG}`);
      });
      return;
    }
    dialog.showErrorBox(
      'Tower のサーバーが何度も止まりました',
      `終了コード ${code ?? signal ?? '?'}\n${tail.join('').trim().slice(-600)}\n\n記録: ${SERVER_LOG}\nTower を開き直してください`,
    );
  });
  for (let i = 0; i < 120; i++) {
    if (exited) {
      const why = exited.error ?? `終了コード ${exited.code ?? exited.signal ?? '?'}`;
      throw new Error(`Tower のサーバーがすぐに止まりました（${why}）\n${tail.join('').trim().slice(-600)}`);
    }
    if (await up(health)) {
      started = true;
      return 'spawned';
    }
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
  if (!BUNDLED && (await up('http://localhost:5173/'))) return 'http://localhost:5173/';
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
    show: !HIDDEN,
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
  // インストールした版だけ: Windows にサインインした時に自動で開く（トレイに常駐。窓は出さない）
  const loginItem = app.isPackaged
    ? [
        {
          label: 'サインイン時に自動で開く（トレイに常駐）',
          type: 'checkbox',
          checked: app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: LOGIN_ARGS }),
        },
        { type: 'separator' },
      ]
    : [];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '開く', click: show },
      { type: 'separator' },
      ...loginItem,
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
    // 画面の needsYou（apps/web/src/lib.ts）と同じ条件: 許可・質問か、報告で判断を求めて止まっているもの
    const waiting = [...sessions.values()].filter(
      (s) => s.pending || (s.status === 'idle' && s.report && (s.report.needsDecision || s.report.outcome === 'question')),
    ).length;
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

// 2 つ目を開こうとしたら（デスクトップのアイコンをもう一度押した等）、今ある窓を前に出すだけ
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', show);
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
    if (!SMOKE) dialog.showErrorBox('Tower を開けませんでした', e instanceof Error ? e.message : String(e));
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
