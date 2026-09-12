// 手元のコードで Windows 版を入れ直す（「直したら使う」を 1 コマンドに）。
//   npm run deploy                  画面ビルド → インストーラ → 動いている Tower を止める → 入れ直し → 開く
//   npm run deploy -- --skip-build  出来ているインストーラ（apps/desktop/dist）をそのまま入れ直す
//
// 注意: 入れ直す時に Tower のサーバーも止まるので、その時に動いていたセッションは「停止」になる（指示を送れば続きから再開）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const args = new Set(process.argv.slice(2));
/** Tower.exe（main.cjs）と同じく、~/.tower/config.json のポートを見る */
function configuredPort() {
  try {
    const p = Number(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.tower', 'config.json'), 'utf8')).port);
    if (p > 0) return p;
  } catch {
    /* 既定 */
  }
  return 4800;
}
const PORT = Number(process.env.TOWER_PORT) > 0 ? Number(process.env.TOWER_PORT) : configuredPort();
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const setup = path.join(HERE, 'dist', `Tower-Setup-${version}.exe`);
const installed = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Tower', 'Tower.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};
function health() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ ok: true });
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

if (process.platform !== 'win32') fail('今のところ Windows 用です（他の OS は npm run desktop で）');

/** 自分の先祖プロセスの名前（Tower の中の Claude Code から実行されると、Tower を止めた時に自分も止まる） */
function ancestorNames() {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation'],
    { encoding: 'utf8' },
  );
  const procs = new Map();
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const m = line.match(/^"(\d+)","(\d*)","(.*)"$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), name: m[3] });
  }
  const names = [];
  const seen = new Set();
  for (let pid = procs.get(process.pid)?.ppid; pid && procs.has(pid) && !seen.has(pid); pid = procs.get(pid).ppid) {
    seen.add(pid);
    names.push(procs.get(pid).name);
  }
  return names;
}
if (ancestorNames().some((n) => /^Tower\.exe$/i.test(n))) {
  fail('Tower の中（Tower が起動した Claude Code）から実行されています。Tower を止めると自分も止まってしまうので、VS Code のターミナルなど Tower の外から npm run deploy を実行してください');
}

// 1. 作る
if (!args.has('--skip-build')) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'build.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) fail('インストーラを作れませんでした');
}
if (!fs.existsSync(setup)) fail(`インストーラがありません: ${setup}（npm run installer で作れます）`);

// 2. 動いているものを止める（Tower.exe と、その子のサーバー）
console.log('\n動いている Tower を止めます');
spawnSync('taskkill', ['/IM', 'Tower.exe', '/T', '/F'], { stdio: 'ignore' });
// Tower の子のサーバーが消えるまで少し待つ。それでも残っていれば別のサーバー（開発用など）
let leftover = null;
for (let i = 0; i < 10 && (leftover = await health()); i++) await sleep(500);
if (leftover) {
  fail(
    `ポート ${PORT} で別のサーバー（版 ${leftover.version ?? '?'}）が動いています（npm run dev などの開発用？）。それを止めないと、入れ直した Tower はそちらにつながり、新しい版になりません。止めてからもう一度実行してください`,
  );
}

// 3. 入れ直す（サイレント）
console.log(`入れ直します: ${path.relative(ROOT, setup)}`);
const before = fs.existsSync(installed) ? fs.statSync(installed).mtimeMs : 0;
const inst = spawnSync(setup, ['/S'], { stdio: 'inherit' });
if (inst.status !== 0) fail(`インストーラが失敗しました（終了コード ${inst.status}）`);
for (let i = 0; i < 120 && !(fs.existsSync(installed) && fs.statSync(installed).mtimeMs > before); i++) await sleep(500);
if (!fs.existsSync(installed)) fail(`入った先が見つかりません: ${installed}`);

// 4. 開く
console.log(`開きます: ${installed}`);
// Electronベースの開発環境から実行しても、アプリをNodeモードで起動しない。
const launchEnv = { ...process.env };
delete launchEnv.ELECTRON_RUN_AS_NODE;
spawn(installed, [], { detached: true, stdio: 'ignore', cwd: path.dirname(installed), env: launchEnv }).unref();
let h = null;
for (let i = 0; i < 120 && !(h = await health()); i++) await sleep(500);
if (!h) fail('起動しましたが、サーバーが応答しません（Tower の窓にエラーが出ていないか見てください）');
if (h.version && h.version !== version) fail(`動いているのは版 ${h.version} で、入れ直した ${version} ではありません（別のサーバーにつながっています）`);
console.log(`\n✔ Tower ${h.version ?? '?'} が動いています: http://127.0.0.1:${PORT}/`);
