import { useEffect, useState } from 'react';
import type { ReportOutcome, RiskLevel, SessionStatus } from '@tower/shared';

export const STATUS: Record<SessionStatus, { label: string; dot: string; badge: string; attention?: boolean }> = {
  starting: { label: '起動中', dot: 'bg-zinc-400 animate-pulse', badge: 'bg-zinc-700 text-zinc-200' },
  running: { label: '作業中', dot: 'bg-sky-400 animate-pulse', badge: 'bg-sky-900/70 text-sky-200' },
  waiting_permission: {
    label: '許可待ち',
    dot: 'bg-amber-400',
    badge: 'bg-amber-400 text-black font-semibold',
    attention: true,
  },
  waiting_question: {
    label: '質問あり',
    dot: 'bg-violet-400',
    badge: 'bg-violet-500 text-white font-semibold',
    attention: true,
  },
  idle: { label: '報告あり', dot: 'bg-emerald-400', badge: 'bg-emerald-900/70 text-emerald-200' },
  done: { label: '終了', dot: 'bg-zinc-500', badge: 'bg-zinc-800 text-zinc-300' },
  error: { label: 'エラー', dot: 'bg-red-500', badge: 'bg-red-900/70 text-red-200' },
  stopped: { label: '停止', dot: 'bg-zinc-500', badge: 'bg-zinc-800 text-zinc-300' },
};

export const OUTCOME: Record<ReportOutcome, { label: string; cls: string }> = {
  done: { label: '✅ 完了', cls: 'bg-emerald-900/70 text-emerald-200' },
  partial: { label: '⚠️ 一部完了', cls: 'bg-amber-900/70 text-amber-200' },
  failed: { label: '❌ 失敗', cls: 'bg-red-900/70 text-red-200' },
  question: { label: '❓ 質問あり', cls: 'bg-violet-900/70 text-violet-200' },
  unknown: { label: '📝 報告', cls: 'bg-zinc-800 text-zinc-300' },
};

export const RISK: Record<RiskLevel, { label: string; cls: string }> = {
  low: { label: '危険度 低', cls: 'bg-emerald-900/70 text-emerald-200' },
  mid: { label: '危険度 中', cls: 'bg-amber-900/70 text-amber-200' },
  high: { label: '危険度 高', cls: 'bg-red-600 text-white font-semibold' },
};

export const ALIVE: SessionStatus[] = ['starting', 'running', 'waiting_permission', 'waiting_question', 'idle'];
export const isAlive = (s: SessionStatus) => ALIVE.includes(s);

export function fmtElapsed(from: number, to = Date.now()): string {
  const s = Math.max(0, Math.floor((to - from) / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${m % 60}分`;
  return `${Math.floor(h / 24)}日`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

/** トークン数を「1.2万」「3.4千」のように短く */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}千`;
  if (n < 100000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.round(n / 10000)}万`;
}

/** 費用の目安。1 セント未満は「$0.01 未満」 */
export function fmtUsd(x: number): string {
  if (x <= 0) return '$0';
  if (x < 0.005) return '$0.01 未満';
  return `$${x.toFixed(2)}`;
}

/** 経過時間表示のために定期的に再描画する */
export function useTick(ms = 15000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export const btn = {
  base: 'px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition',
  primary: 'bg-sky-600 hover:bg-sky-500 text-white',
  success: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  danger: 'bg-red-700 hover:bg-red-600 text-white',
  ghost: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200',
};
