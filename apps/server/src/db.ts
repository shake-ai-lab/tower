// 永続化: Node 組み込みの node:sqlite。セッションと年表を JSON で保存する。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { Session, TimelineItem, UsageSum, UsageSummary } from '@tower/shared';
import { DATA_DIR } from './config.ts';

/**
 * 使った量の台帳の 1 行。セッションの usage が増えるたびに差分を積む。
 * セッションを消しても残るので、「使った量」の合計がタスクの削除で減らない。
 * dated: 1 = 記録時刻が正しい, 0 = 日付を復元できない古い分（「全部」にだけ入れる）
 */
export interface UsageRow {
  ts: number;
  session_id: string;
  project_path: string;
  project_name: string;
  agent: string;
  model: string | null;
  cost: number;
  input: number;
  cache_read: number;
  output: number;
  dated: 0 | 1;
}

const USAGE_SUM_COLUMNS =
  'COUNT(DISTINCT session_id) AS count, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cache_read), 0) AS cacheRead, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cost), 0) AS cost';

const toSum = (row: Record<string, unknown> | undefined): UsageSum => ({
  count: Number(row?.count ?? 0),
  input: Number(row?.input ?? 0),
  cacheRead: Number(row?.cacheRead ?? 0),
  output: Number(row?.output ?? 0),
  cost: Number(row?.cost ?? 0),
});

/** フォルダの書き方の違いを吸収した比較用の鍵（Windows は大文字小文字を区別しない） */
function projectKey(value: string): string {
  const windows = /^[a-z]:[/\\]/i.test(value) || value.startsWith('\\\\');
  let normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (windows) normalized = normalized.toLowerCase();
  return normalized || '/';
}

export class Db {
  private db: DatabaseSync;

  constructor(file = path.join(DATA_DIR, 'tower.db')) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS timeline (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS timeline_session ON timeline(session_id, ts);
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        project_name TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        cost REAL NOT NULL,
        input INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        output INTEGER NOT NULL,
        dated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /** 使った量の台帳に 1 行積む（セッションを消しても残る） */
  appendUsage(row: UsageRow) {
    this.db
      .prepare(
        'INSERT INTO usage (ts, session_id, project_path, project_name, agent, model, cost, input, cache_read, output, dated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.ts, row.session_id, row.project_path, row.project_name, row.agent, row.model, row.cost, row.input, row.cache_read, row.output, row.dated);
  }

  /**
   * 使った量のまとめ。today / week はサーバーのローカル時刻の 0 時を境に、記録時刻が分かる分（dated = 1）だけ。
   * all は日付を復元できない古い分も含めた全部
   */
  usageSummary(now: number): UsageSummary {
    const d = new Date(now);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const weekStart = dayStart - 6 * 86_400_000;
    const since = (start: number) =>
      toSum(this.db.prepare(`SELECT ${USAGE_SUM_COLUMNS} FROM usage WHERE dated = 1 AND ts >= ?`).get(start) as Record<string, unknown> | undefined);
    const all = toSum(this.db.prepare(`SELECT ${USAGE_SUM_COLUMNS} FROM usage`).get() as Record<string, unknown> | undefined);
    const projectRows = this.db
      .prepare(
        `SELECT project_path AS path, MAX(project_name) AS name, ${USAGE_SUM_COLUMNS} FROM usage WHERE dated = 1 AND ts >= ? GROUP BY project_path`,
      )
      .all(dayStart) as Record<string, unknown>[];
    // 同じフォルダの書き方違い（大文字小文字、区切り文字、末尾の区切り）は一つにまとめてから上位 6 件
    const byKey = new Map<string, UsageSum & { name: string; path: string }>();
    for (const r of projectRows) {
      const row = { ...toSum(r), name: String(r.name ?? ''), path: String(r.path ?? '') };
      const key = projectKey(row.path);
      const cur = byKey.get(key);
      if (!cur) byKey.set(key, row);
      else byKey.set(key, { name: cur.name, path: cur.path, count: cur.count + row.count, input: cur.input + row.input, cacheRead: cur.cacheRead + row.cacheRead, output: cur.output + row.output, cost: cur.cost + row.cost });
    }
    const projectsToday = [...byKey.values()].sort((a, b) => b.input + b.output - (a.input + a.output)).slice(0, 6);
    return {
      today: since(dayStart),
      week: since(weekStart),
      all,
      projectsToday,
    };
  }

  /** まとめて書く（途中で落ちても中途半端に残らない） */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  saveSession(s: Session) {
    this.db
      .prepare('INSERT OR REPLACE INTO sessions (id, json, updated_at) VALUES (?, ?, ?)')
      .run(s.id, JSON.stringify(s), s.updatedAt);
  }

  loadSessions(): Session[] {
    const rows = this.db.prepare('SELECT json FROM sessions ORDER BY updated_at DESC').all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Session);
  }

  deleteSession(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM timeline WHERE session_id = ?').run(id);
  }

  appendTimeline(item: TimelineItem) {
    this.db
      .prepare('INSERT OR REPLACE INTO timeline (id, session_id, ts, json) VALUES (?, ?, ?, ?)')
      .run(item.id, item.sessionId, item.ts, JSON.stringify(item));
  }

  getTimelineItem(sessionId: string, id: string): TimelineItem | undefined {
    const row = this.db.prepare('SELECT json FROM timeline WHERE id = ? AND session_id = ?').get(id, sessionId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as TimelineItem) : undefined;
  }

  loadTimeline(sessionId: string, limit = 500): TimelineItem[] {
    const rows = this.db
      .prepare('SELECT json FROM timeline WHERE session_id = ? ORDER BY ts DESC LIMIT ?')
      .all(sessionId, limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as TimelineItem).reverse();
  }
}
