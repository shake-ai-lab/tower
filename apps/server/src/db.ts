// 永続化: Node 組み込みの node:sqlite。セッションと年表を JSON で保存する。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { Session, TimelineItem } from '@tower/shared';
import { DATA_DIR } from './config.ts';

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
    `);
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
