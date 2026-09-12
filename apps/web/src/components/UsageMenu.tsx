import { useMemo, useState } from 'react';
import type { Session } from '@tower/shared';
import { btn, fmtTokens, fmtUsd } from '../lib';
import { projectKey } from '../project-key';

type Sum = { count: number; input: number; cacheRead: number; output: number; cost: number };
const empty = (): Sum => ({ count: 0, input: 0, cacheRead: 0, output: 0, cost: 0 });
const add = (a: Sum, s: Session) => {
  a.count++;
  a.input += s.usage?.input ?? 0;
  a.cacheRead += s.usage?.cacheRead ?? 0;
  a.output += s.usage?.output ?? 0;
  a.cost += s.costUsd ?? 0;
};

/** 使った量のまとめ（今日 / 今週 / 全部、今日のプロジェクト別）。全セッションから画面側で集計する */
export function UsageMenu({ sessions }: { sessions: Session[] }) {
  const [open, setOpen] = useState(false);
  const stats = useMemo(() => {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = dayStart - 6 * 86_400_000;
    const today = empty();
    const week = empty();
    const all = empty();
    // 同じ名前の別プロジェクト（場所違い）を混ぜないよう、場所で分ける
    const byProject = new Map<string, Sum & { name: string; path: string }>();
    for (const s of sessions) {
      if (s.origin === 'external') continue; // Tower の外で動いているものは量が分からない
      add(all, s);
      const sumSince = (start: number): Sum => {
        const entries = (s.usageHistory ?? []).filter((entry) => entry.ts >= start);
        return entries.reduce((sum, entry) => ({ count: 1, input: sum.input + entry.input, cacheRead: sum.cacheRead + entry.cacheRead, output: sum.output + entry.output, cost: sum.cost + entry.cost }), empty());
      };
      const merge = (target: Sum, value: Sum) => { for (const key of ['count', 'input', 'cacheRead', 'output', 'cost'] as const) target[key] += value[key]; };
      merge(week, sumSince(weekStart));
      const daily = sumSince(dayStart);
      merge(today, daily);
      if (daily.count) {
        const key = projectKey(s.project.path);
        const p = byProject.get(key) ?? { ...empty(), name: s.project.name, path: s.project.path };
        merge(p, daily);
        byProject.set(key, p);
      }
    }
    const dup = new Set([...byProject.values()].map((p) => p.name).filter((n, i, a) => a.indexOf(n) !== i));
    const projects: [string, Sum][] = [...byProject.values()]
      .sort((a, b) => b.input + b.output - (a.input + a.output))
      .slice(0, 6)
      .map((p) => [dup.has(p.name) ? `${p.name}（${p.path}）` : p.name, p]);
    return { today, week, all, projects };
  }, [sessions]);

  const rows: [string, Sum][] = [
    ['今日（記録分）', stats.today],
    ['この7日（記録分）', stats.week],
    ['全部', stats.all],
  ];
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`${btn.base} ${btn.ghost} !text-xs whitespace-nowrap`}
        title="エージェントがタスクに使ったトークン量と費用の目安"
      >
        使った量{stats.today.cost > 0 && <span className="opacity-70 ml-1">今日の記録 {fmtUsd(stats.today.cost)}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[min(420px,calc(100vw-2rem))] rounded-lg border border-zinc-700 bg-[#171a21] shadow-xl p-3 text-xs z-50 space-y-3">
          <table className="w-full">
            <thead className="text-zinc-500">
              <tr>
                <th className="text-left font-normal py-0.5" />
                <th className="text-right font-normal py-0.5">タスク</th>
                <th className="text-right font-normal py-0.5">読んだ</th>
                <th className="text-right font-normal py-0.5">書いた</th>
                <th className="text-right font-normal py-0.5">費用の目安</th>
              </tr>
            </thead>
            <tbody className="text-zinc-200">
              {rows.map(([label, v]) => (
                <tr key={label} className="border-t border-zinc-800">
                  <td className="py-1 text-zinc-400">{label}</td>
                  <td className="py-1 text-right">{v.count}</td>
                  <td className="py-1 text-right" title={`うち使い回し ${fmtTokens(v.cacheRead)}`}>
                    {fmtTokens(v.input)}
                  </td>
                  <td className="py-1 text-right">{fmtTokens(v.output)}</td>
                  <td className="py-1 text-right">{fmtUsd(v.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stats.projects.length > 0 && (
            <div>
              <div className="text-zinc-500 mb-1">今日のプロジェクト別</div>
              {stats.projects.map(([name, v]) => (
                <div key={name} className="flex justify-between gap-2 py-0.5 border-t border-zinc-800/60">
                  <span className="truncate text-zinc-300">{name}</span>
                  <span className="whitespace-nowrap text-zinc-400">
                    {v.count} 本
                    {v.input + v.output > 0 && ` · 読んだ ${fmtTokens(v.input)} · 書いた ${fmtTokens(v.output)}`} · {fmtUsd(v.cost)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="text-zinc-500 leading-relaxed">
            エージェントがタスクの作業に使った量です。Tower 自体は AI を呼びません（例外: 書式の無い報告を整形する時だけ、小さなモデルを 1 回）。
            「読んだ」の大半は前回までの会話の使い回し（キャッシュ）で、新しく読ませた分よりずっと軽く数えられます。
            使用量が報告された日で集計します。更新前の使用量は日付を復元できないため「全部」のみに含まれます。実行中の未報告分・外部タスク・費用を報告しないエージェントの費用は含まれません。表示額はアカウント全体の合計ではありません。
          </p>
        </div>
      )}
    </div>
  );
}
