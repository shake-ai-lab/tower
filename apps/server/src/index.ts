// Tower サーバー: REST（操作）+ WebSocket（状態配信）
import fs from 'node:fs';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer } from 'ws';
import {
  workDir,
  type AnswerBody,
  type CreateFeedbackBody,
  type CreateSessionBody,
  type CompareBody,
  type FeedbackStatus,
  type MessageBody,
  type PermissionDecisionBody,
  type PermissionChoice,
  type ProjectInfo,
  type SaveFileBody,
  type SettingsStatus,
  type TowerSettings,
} from '@tower/shared';
import { Bridge, type HookInput } from './bridge.ts';
import { CONFIG_PATH, loadConfig, saveConfig, validateSettings } from './config.ts';
import { Db } from './db.ts';
import { collectChanges, lineMarks } from './diff.ts';
import { listAllFiles, searchText } from './search.ts';
import { FeedbackFile } from './feedback.ts';
import { checkImage, listDir, readFileContent, resolveImage, writeFileContent } from './files.ts';
import { Hub } from './hub.ts';
import { startJanitor } from './janitor.ts';
import { SessionManager, agentAvailability } from './manager.ts';
import { SHOTS_DIR } from './preview.ts';
import { setReformatEnabled } from './reformat.ts';
import { setVerifyEnabled } from './verify.ts';
import { VERSION } from './version.ts';
import { diffBase } from './worktree.ts';
import { browseProjects } from './project-browser.ts';
import { codexLoginState, startCodexLogin } from './codex-login.ts';

const config = loadConfig();
/** 起動時の待ち受け。画面から変えても、これと違う間は「開き直してください」と出す */
const bootListen = { host: config.host, port: config.port };
let feedback = new FeedbackFile(config.feedbackFile);
setVerifyEnabled(config.autoVerify);
setReformatEnabled(config.reformatReports);
const db = new Db();
const hub = new Hub(db);
const manager = new SessionManager(hub);
const bridge = new Bridge(hub, { port: config.port, waitSeconds: config.bridgeWaitSeconds });
let stopJanitor = startJanitor(hub, config.externalKeepHours);

function settingsStatus(): SettingsStatus {
  const needsRestart: string[] = [];
  if (config.host !== bootListen.host) needsRestart.push(`待ち受けアドレス（${bootListen.host} → ${config.host}）`);
  if (config.port !== bootListen.port) needsRestart.push(`ポート（${bootListen.port} → ${config.port}）`);
  return { file: CONFIG_PATH, settings: { ...config }, version: VERSION, needsRestart };
}

/** 画面からの設定変更をファイルに書き、再起動が要らないものはその場で反映する */
function applySettings(patch: Partial<TowerSettings>) {
  const saved = saveConfig(patch);
  Object.assign(config, saved);
  setVerifyEnabled(config.autoVerify);
  setReformatEnabled(config.reformatReports);
  if (feedback.file !== config.feedbackFile) feedback = new FeedbackFile(config.feedbackFile);
  bridge.setWaitSeconds(config.bridgeWaitSeconds);
  if (patch.externalKeepHours !== undefined) {
    stopJanitor();
    stopJanitor = startJanitor(hub, config.externalKeepHours);
  }
}

function listProjects(): ProjectInfo[] {
  const out: ProjectInfo[] = [];
  for (const root of config.projectRoots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(root, e.name);
      let modifiedAt = 0;
      try {
        modifiedAt = fs.statSync(p).mtimeMs;
      } catch {
        /* ignore */
      }
      out.push({ path: p, name: e.name, hasGit: fs.existsSync(path.join(p, '.git')), modifiedAt });
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

const app = new Hono();
app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ ok: true, sessions: hub.sessions.size, version: VERSION }));
app.get('/api/config', (c) => c.json(config));
app.get('/api/projects', (c) => c.json(listProjects()));
app.get('/api/projects/browse', (c) => {
  try { return c.json(browseProjects(c.req.query('path') ?? '')); }
  catch (e) { return c.json({ error: `フォルダを開けません: ${e instanceof Error ? e.message : String(e)}` }, 400); }
});

// ---- 設定（画面の「設定」タブ。~/.tower/config.json を読み書きする） ----
app.get('/api/settings', (c) => c.json(settingsStatus()));

app.put('/api/settings', async (c) => {
  try {
    const patch = validateSettings((await c.req.json()) as Partial<TowerSettings>);
    applySettings(patch);
    return c.json(settingsStatus());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
app.get('/api/agents', (c) => c.json(agentAvailability(c.req.query('refresh') === '1')));
app.use('/api/agents/codex/login', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: '同じTower画面から操作してください' }, 403);
  if (c.req.method === 'POST' && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSONが必要です' }, 415);
  await next();
});
app.get('/api/agents/codex/login', (c) => c.json(codexLoginState()));
app.post('/api/agents/codex/login', (c) => {
  try { return c.json(startCodexLogin()); }
  catch { return c.json({ error: '同梱のCodexを起動できませんでした。Towerを再インストールしてください。' }, 500); }
});
app.get('/api/sessions', (c) => c.json(hub.list()));

app.post('/api/sessions', async (c) => {
  const body = (await c.req.json()) as CreateSessionBody;
  try {
    const s = manager.create(body);
    return c.json(s, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// 同じ依頼を複数のモデルに投げて比べる（全部「別の作業場所」）
app.post('/api/sessions/compare', async (c) => {
  const body = (await c.req.json()) as CompareBody;
  try {
    return c.json(manager.createCompare(body), 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.get('/api/sessions/:id/timeline', (c) => c.json(db.loadTimeline(c.req.param('id'))));

app.get('/api/sessions/:id/changes', (c) => {
  const s = hub.get(c.req.param('id'));
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404);
  try {
    if (s.workspace) {
      const r = collectChanges(workDir(s), s.changedFiles, diffBase(s.workspace));
      return c.json({ ...r, against: `元のプロジェクト（${s.workspace.baseBranch || '分離した時点'}）` });
    }
    return c.json(collectChanges(s.project.path, s.changedFiles));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// ---- 見た目のスクリーンショット ----
app.get('/api/sessions/:id/shots/:file', (c) => {
  const id = c.req.param('id');
  const file = c.req.param('file');
  if (!/^[\w-]+$/.test(id) || !/^[\w.-]+\.png$/.test(file)) return c.text('bad request', 400);
  const p = path.join(SHOTS_DIR, id, file);
  if (!fs.existsSync(p)) return c.text('not found', 404);
  return c.body(new Uint8Array(fs.readFileSync(p)), 200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' });
});

// ---- エクスプローラ（作業フォルダの中身を 1 階層ずつ） ----
app.get('/api/sessions/:id/tree', (c) => {
  const s = hub.get(c.req.param('id'));
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404);
  try {
    return c.json(listDir(workDir(s), c.req.query('path') ?? ''));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// ---- エディタの道具（ファイル名で開く・全体検索・変わった行の印） ----
app.get('/api/sessions/:id/files', (c) => {
  const s = hub.get(c.req.param('id'));
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404);
  try {
    return c.json(listAllFiles(workDir(s)));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.get('/api/sessions/:id/search', (c) => {
  const s = hub.get(c.req.param('id'));
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404);
  const q = c.req.query('q') ?? '';
  if (q.length > 200) return c.json({ error: '探す文字が長すぎます（200 文字まで）' }, 400);
  try {
    return c.json(searchText(workDir(s), q, c.req.query('case') === '1'));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.get('/api/sessions/:id/line-marks', (c) => {
  const s = hub.get(c.req.param('id'));
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404);
  const rel = c.req.query('path') ?? '';
  if (!rel) return c.json({ error: 'path がありません' }, 400);
  try {
    const marks = lineMarks(workDir(s), rel, s.workspace ? diffBase(s.workspace) : 'HEAD');
    const against = marks === null ? null : s.workspace ? `元のプロジェクト（${s.workspace.baseBranch || '分離した時点'}）` : '最後の記録（コミット）';
    return c.json({ marks: marks ?? [], against });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// 画像をそのまま返す（画面のエディタで表示する用）
app.get('/api/sessions/:id/raw', (c) => {
  const s = hub.get(c.req.param('id'));
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404);
  const rel = c.req.query('path') ?? '';
  if (!rel) return c.json({ error: 'path がありません' }, 400);
  try {
    const f = resolveImage(workDir(s), rel);
    return c.body(new Uint8Array(fs.readFileSync(f.abs)), 200, imageHeaders(f.mime));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// 年表: エージェントが読んだ画像を見せる。作業フォルダの外（一時フォルダなど）でも、その項目に記録された画像だけは返す
app.get('/api/sessions/:id/timeline/:itemId/image', (c) => {
  const s = hub.get(c.req.param('id'));
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404);
  const item = db.getTimelineItem(s.id, c.req.param('itemId'));
  if (!item?.imagePath) return c.json({ error: '画像の記録がありません' }, 404);
  try {
    const f = checkImage(path.resolve(workDir(s), item.imagePath));
    return c.body(new Uint8Array(fs.readFileSync(f.abs)), 200, imageHeaders(f.mime));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
  }
});

function imageHeaders(mime: string) {
  return { 'content-type': mime, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" };
}

// ---- 画面からの直接編集（Monaco） ----
app.get('/api/sessions/:id/file', (c) => {
  const s = hub.get(c.req.param('id'));
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404);
  const rel = c.req.query('path') ?? '';
  if (!rel) return c.json({ error: 'path がありません' }, 400);
  try {
    return c.json(readFileContent(workDir(s), rel));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.put('/api/sessions/:id/file', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json()) as SaveFileBody;
  if (!body.path || typeof body.content !== 'string') return c.json({ error: 'path と content が必要です' }, 400);
  try {
    const dir = manager.editableDir(id);
    const rel = writeFileContent(dir, body.path, body.content);
    manager.manualEdit(id, rel);
    return c.json({ ok: true, path: rel });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

app.post('/api/sessions/:id/merge', (c) => {
  try {
    return c.json(manager.merge(c.req.param('id')));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

app.post('/api/sessions/:id/message', async (c) => {
  const body = (await c.req.json()) as MessageBody;
  if (!body.text?.trim()) return c.json({ error: '空です' }, 400);
  try {
    manager.send(c.req.param('id'), body.text.trim());
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

app.post('/api/sessions/:id/permission', async (c) => {
  const body = (await c.req.json()) as PermissionDecisionBody;
  const r = manager.runner(c.req.param('id'));
  let ok: boolean;
  if (r) ok = body.decision === 'defer' ? false : r.resolvePermission(body.requestId, body.decision, body.message);
  else ok = bridge.resolvePermission(body.requestId, body.decision, body.message);
  return ok ? c.json({ ok: true }) : c.json({ error: 'その許可要求はもう有効ではありません' }, 409);
});

app.put('/api/sessions/:id/permission-mode', async (c) => {
  try {
    const body = await c.req.json() as { mode: PermissionChoice };
    return c.json(await manager.setPermissionMode(c.req.param('id'), body.mode));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

// ---- VS Code / ターミナル連携（Claude Code hooks からの通知） ----
app.post('/api/hooks/event', async (c) => {
  try {
    bridge.handleEvent((await c.req.json()) as HookInput);
  } catch (e) {
    console.warn('[bridge] event error', e);
  }
  return c.json({});
});

app.post('/api/hooks/permission', async (c) => {
  try {
    return c.json(await bridge.handlePermission((await c.req.json()) as HookInput));
  } catch (e) {
    console.warn('[bridge] permission error', e);
    return c.json({});
  }
});

app.get('/api/bridge', (c) => c.json(bridge.status()));

app.post('/api/bridge', async (c) => {
  const body = (await c.req.json()) as { enabled?: boolean; permissions?: boolean };
  try {
    return c.json(bridge.install(body.enabled !== false, body.permissions === true));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.post('/api/sessions/:id/answer', async (c) => {
  const r = manager.runner(c.req.param('id'));
  if (!r) return c.json({ error: 'このセッションは動いていません' }, 404);
  const body = (await c.req.json()) as AnswerBody;
  const ok = r.answerQuestion(body.requestId, body.answers);
  return ok ? c.json({ ok: true }) : c.json({ error: 'その質問はもう有効ではありません' }, 409);
});

// ---- 気づいたこと（使いながらの不満・要望を Markdown に溜める。Claude Code がそれを読んで直す） ----
app.get('/api/feedback', (c) => {
  const body: FeedbackStatus = { file: feedback.file, version: VERSION, notes: feedback.list() };
  return c.json(body);
});

app.post('/api/feedback', async (c) => {
  const body = (await c.req.json()) as CreateFeedbackBody;
  try {
    return c.json(feedback.add(body), 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.delete('/api/feedback/:id', (c) => {
  const id = c.req.param('id');
  if (!/^[a-z0-9]{6,}$/.test(id)) return c.json({ error: 'id が不正です' }, 400);
  return feedback.remove(id) ? c.json({ ok: true }) : c.json({ error: 'その項目はもうありません' }, 404);
});

app.post('/api/sessions/:id/stop', async (c) => {
  const ok = await manager.stop(c.req.param('id'));
  return c.json({ ok });
});

app.delete('/api/sessions/:id', async (c) => {
  await manager.remove(c.req.param('id'));
  return c.json({ ok: true });
});

// ---- 画面（ビルド済み）の配信。`npm run build -w apps/web` の後なら、このポートだけで全部動く（デスクトップ版・スマホ用） ----
// デスクトップ版（1 ファイルに束ねたサーバー）では置き場所が変わるので、環境変数で指せる
const WEB_DIST = process.env.TOWER_WEB_DIST || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  const root = path.relative(process.cwd(), WEB_DIST).split(path.sep).join('/') || '.';
  app.use('/*', serveStatic({ root }));
  // SPA: それ以外のパスは index.html
  app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.notFound() : c.html(fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8'))));
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(
    `[tower] http://${info.address}:${info.port}  projects: ${config.projectRoots.join(', ') || '(なし)'}`,
  );
});

const wss = new WebSocketServer({ server: server as HttpServer, path: '/ws' });
wss.on('connection', (ws) => {
  const unsub = hub.subscribe((ev) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
  });
  ws.on('close', unsub);
  ws.on('error', unsub);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[tower] ${sig}: 全セッションを停止します`);
    await manager.stopAll();
    process.exit(0);
  });
}
