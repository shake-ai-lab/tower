import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, UsageSum, UsageSummary } from '@tower/shared';
import { api } from '../api';
import { btn, fmtTokens, fmtUsd } from '../lib';

const empty = (): UsageSum => ({ count: 0, input: 0, cacheRead: 0, output: 0, cost: 0 });

/**
 * 使った量のまとめ（今日 / 今週 / 全部、今日のプロジェクト別）。
 * サーバー側の台帳（GET /api/usage）から出すので、タスクを消しても合計は減らない。
 * sessions は「量が動いたら取り直す」ための指紋にだけ使う
 */
export function UsageMenu({ sessions }: { sessions: Session[] }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);

  // 指紋: タスク数と（外部を除く）費用・トークンの合計。これが変わったら台帳も動いているはずなので取り直す
  const fingerprint = useMemo(() => {
    let cost = 0;
    let tokens = 0;
    for (const s of sessions) {
      if (s.origin === 'external') continue; // Tower の外で動いているものは量が分からない
      cost += s.costUsd ?? 0;
      tokens += (s.usage?.input ?? 0) + (s.usage?.output ?? 0);
    }
    return `${sessions.length}:${cost}:${tokens}`;
  }, [sessions]);

  // 先に出した問い合わせが後から返っても、古い値で上書きしない
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    api
      .usage()
      .then((s) => {
        if (mine !== seq.current) return;
        setSummary(s);
        setFailed(false);
      })
      .catch(() => {
        if (mine === seq.current) setFailed(true);
      });
  }, []);

  // 初回はすぐ取り、以後は指紋が変わってから 1 秒待って取る（更新が続く間に何度も取りに行かない）
  const loadedOnce = useRef(false);
  useEffect(() => {
    if (!loadedOnce.current) {
      loadedOnce.current = true;
      load();
      return;
    }
    const timer = setTimeout(load, 1000);
    return () => clearTimeout(timer);
  }, [fingerprint, load]);

  // 開いた時にも取り直す
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const stats = summary ?? { today: empty(), week: empty(), all: empty(), projectsToday: [] };
  // 同じ名前の別プロジェクト（場所違い）が並んだら、場所を添えて区別する
  const projects = useMemo<[string, UsageSum][]>(() => {
    const dup = new Set(stats.projectsToday.map((p) => p.name).filter((n, i, a) => a.indexOf(n) !== i));
    return stats.projectsToday.map((p) => [dup.has(p.name) ? `${p.name}（${p.path}）` : p.name, p]);
  }, [stats.projectsToday]);

  const rows: [string, UsageSum][] = [
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
          {failed && <p className="text-amber-400/80">取得できませんでした</p>}
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
          {projects.length > 0 && (
            <div>
              <div className="text-zinc-500 mb-1">今日のプロジェクト別</div>
              {projects.map(([name, v]) => (
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
            エージェントがタスクの作業に使った量です。Tower 自体は AI を呼びません。
            「読んだ」の大半は前回までの会話の使い回し（キャッシュ）で、新しく読ませた分よりずっと軽く数えられます。
            使用量が報告された日で集計します。更新前の使用量は日付を復元できないため「全部」のみに含まれます。消したタスクの分も残ります。実行中の未報告分・外部タスク・費用を報告しないエージェントの費用は含まれません。表示額はアカウント全体の合計ではありません。
          </p>
        </div>
      )}
    </div>
  );
}
