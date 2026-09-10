// Tower サーバー: REST（操作）+ WebSocket（状態配信）
import fs from 'node:fs';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer } from 'ws';
import {
  workDir,
  type AnswerBody,
  type CreateSessionBody,
  type MessageBody,
  type PermissionDecisionBody,
  type ProjectInfo,
} from '@tower/shared';
import { Bridge, type HookInput } from './bridge.ts';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { collectChanges } from './diff.ts';
import { Hub } from './hub.ts';
import { SessionManager, agentAvailability } from './manager.ts';
import { setVerifyEnabled } from './verify.ts';
import { diffBase } from './worktree.ts';

const config = loadConfig();
setVerifyEnabled(config.autoVerify);
const db = new Db();
const hub = new Hub(db);
const manager = new SessionManager(hub);
const bridge = new Bridge(hub, { port: config.port, waitSeconds: config.bridgeWaitSeconds });

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

app.get('/api/health', (c) => c.json({ ok: true, sessions: hub.sessions.size }));
app.get('/api/config', (c) => c.json(config));
app.get('/api/projects', (c) => c.json(listProjects()));
app.get('/api/agents', (c) => c.json(agentAvailability()));
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

app.post('/api/sessions/:id/stop', async (c) => {
  const ok = await manager.stop(c.req.param('id'));
  return c.json({ ok });
});

app.delete('/api/sessions/:id', async (c) => {
  await manager.remove(c.req.param('id'));
  return c.json({ ok: true });
});

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
