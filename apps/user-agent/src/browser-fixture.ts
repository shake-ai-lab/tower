// Backend boundary only: the agent operates the real React/Monaco UI.
// All API/WS traffic is intercepted; nothing reaches the user's Tower database.
import type { BrowserContext } from 'playwright-core';
import type { Session, SearchResponse, TreeEntry } from '@tower/shared';

export async function installFixture(context: BrowserContext) {
  const files = new Map([
    ['notes.txt', '買い物メモ\napple と banana を買う\n'],
    ['README.md', '# お試しプロジェクト\n\n[メモを開く](notes.txt)\n'],
    ['src/main.ts', 'export const fruit = "apple";\n'],
  ]);
  const session: Session = {
    id: 'ux-sandbox', agent: 'claude', agentSessionId: null,
    project: { path: 'C:/tower-ux-sandbox', name: '操作検証プロジェクト' },
    title: 'メモを読み、探して編集する', prompt: 'メモを読み、探して編集する',
    model: null, permissionMode: 'default', status: 'stopped', activity: '操作検証用',
    pending: null, report: null, turns: 0, costUsd: 0, toolCalls: 0,
    changedFiles: [], createdAt: Date.now(), updatedAt: Date.now(), lastError: null,
  };
  const faults = { search: false, searchDelay: 0, filesDelay: 0, save: false };
  const unexpected: string[] = [];
  await context.routeWebSocket('**/ws', (ws) => ws.send(JSON.stringify({ type: 'snapshot', sessions: [session] })));
  await context.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if (p === '/api/sessions' && request.method() === 'GET') return json([session]);
    if (p === '/api/config') return json({ externalKeepHours: 24 });
    if (p === '/api/feedback') return json({ file: 'memory:feedback', version: 'fixture', notes: [] });
    if (p === '/api/bridge') return json({ installed: false, permissions: false });
    if (p === '/api/projects') return json([session.project]);
    if (p.endsWith('/timeline')) return json([]);
    if (p.endsWith('/files')) { await delay(faults.filesDelay); return json({ files: [...files.keys()], truncated: false }); }
    if (p.endsWith('/tree')) {
      const prefix = url.searchParams.get('path') ? url.searchParams.get('path') + '/' : '';
      const entries = new Map<string, TreeEntry>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const tail = key.slice(prefix.length), name = tail.split('/')[0];
        entries.set(name, { name, path: prefix + name, kind: tail.includes('/') ? 'dir' : 'file' });
      }
      return json({ path: prefix.replace(/\/$/, ''), entries: [...entries.values()], skipped: [], truncated: 0 });
    }
    if (p.endsWith('/line-marks')) return json({ marks: [], against: 'HEAD' });
    if (p.endsWith('/search')) {
      const fail = faults.search;
      await delay(faults.searchDelay);
      if (fail) return json({ error: '検証用: 検索サーバーに接続できません' }, 503);
      const q = url.searchParams.get('q') ?? '', sensitive = url.searchParams.get('case') === '1';
      const result: SearchResponse = { query: q, files: [], total: 0, truncated: false };
      if (q) for (const [file, content] of files) {
        const matches = content.split('\n').flatMap((text, i) => {
          const source = sensitive ? text : text.toLowerCase(), needle = sensitive ? q : q.toLowerCase();
          const found = [];
          for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + needle.length))
            found.push({ line: i + 1, column: at + 1, length: q.length, text, at });
          return found;
        });
        if (matches.length) result.files.push({ path: file, matches });
        result.total += matches.length;
      }
      return json(result);
    }
    if (p.endsWith('/file')) {
      if (request.method() === 'PUT') {
        if (faults.save) return json({ error: '検証用: 保存できません' }, 503);
        const body = request.postDataJSON();
        if (!files.has(body.path) || typeof body.content !== 'string') return json({ error: '検証対象外' }, 400);
        files.set(body.path, body.content);
        return json({ ok: true, path: body.path });
      }
      const file = url.searchParams.get('path') ?? '';
      return files.has(file) ? json({ path: file, content: files.get(file) }) : json({ error: 'ファイルがありません' }, 404);
    }
    unexpected.push(`${request.method()} ${p}`);
    return json({ error: '操作検証ではこの操作を実行しません' }, 501);
  });
  return { files, faults, unexpected };
}
