// 掃除: 外部（VS Code / ターミナル）のセッションは、Tower 側に「消すきっかけ」が無いので放っておくと溜まる。
// 最後の動きから一定時間たったものは一覧から消す。次に何か動けば hooks からまた入ってくるので、消しても困らない。
// Tower 自身が起動したセッションは利用者が「削除」を押すまで残す（報告や履歴を後から見返すため）。
import type { Hub } from './hub.ts';

/** keepHours 以上動きの無い外部セッションを消す。消した id を返す。keepHours が 0 以下なら何もしない */
export function sweepExternal(hub: Hub, keepHours: number, now = Date.now()): string[] {
  if (!(keepHours > 0)) return [];
  const limit = now - keepHours * 3600_000;
  const removed: string[] = [];
  for (const s of [...hub.sessions.values()]) {
    if (s.origin !== 'external') continue;
    if (s.updatedAt > limit) continue;
    hub.remove(s.id);
    removed.push(s.id);
  }
  return removed;
}

/** 起動時と、その後は定期的に掃除する */
export function startJanitor(hub: Hub, keepHours: number, intervalMs = 10 * 60_000): () => void {
  const run = () => {
    const removed = sweepExternal(hub, keepHours);
    if (removed.length) console.log(`[janitor] ${keepHours}時間動きの無い外部セッション ${removed.length} 件を一覧から消しました`);
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
