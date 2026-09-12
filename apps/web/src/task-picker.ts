// パネルに出すタスクを選ぶメニュー（4分割・集中）の絞り込みと並べ方。画面から切り離してテストできるようにしている
import type { Session, SessionStatus } from '@tower/shared';
import { projectKey } from './project-key';

/** もう動かないもの。ふだんは畳んでおき、探している時（検索中）だけ出す */
export const FINISHED: SessionStatus[] = ['stopped', 'done', 'error'];

export interface TaskGroup {
  key: string;
  project: Session['project'];
  sessions: Session[];
}

/**
 * 渡された順（急ぎのもの → 新しいもの）を保ったままプロジェクトごとにまとめる。急ぎのタスクがあるプロジェクトほど上に来る。
 * 検索語は空白区切りで AND。検索中は終わったものも対象にする
 */
export function pickerGroups(sessions: Session[], query: string, showFinished: boolean): { groups: TaskGroup[]; hiddenFinished: number } {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let hiddenFinished = 0;
  const byKey = new Map<string, TaskGroup>();
  for (const s of sessions) {
    if (words.length) {
      const text = [s.project.name, s.title, s.prompt, s.externalHint ?? ''].join('\n').toLowerCase();
      if (!words.every((w) => text.includes(w))) continue;
    } else if (!showFinished && FINISHED.includes(s.status)) {
      hiddenFinished++;
      continue;
    }
    const key = projectKey(s.project.path);
    let group = byKey.get(key);
    if (!group) byKey.set(key, (group = { key, project: s.project, sessions: [] }));
    group.sessions.push(s);
  }
  return { groups: [...byKey.values()], hiddenFinished };
}

/** 「3分前」「2時間前」のように短く */
export function ago(ts: number, now = Date.now()): string {
  const m = Math.floor(Math.max(0, now - ts) / 60_000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}
