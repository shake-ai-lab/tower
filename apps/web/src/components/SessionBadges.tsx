// セッションに付く小さな札。一覧カード・詳細・パネル選択で同じ見た目を使い回す
import type { ReactNode } from 'react';
import type { Session } from '@tower/shared';
import { STATUS } from '../lib';

/** 状態の札。作業中はくるくる回る印を付けて、止まっているものと見分けやすくする */
export function StatusBadge({ status, className = 'text-xs' }: { status: Session['status']; className?: string }) {
  const st = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full whitespace-nowrap ${className} ${st.badge}`}>
      {st.working && <span aria-hidden="true" className="working-spinner" />}
      {st.label}
    </span>
  );
}

const TONE = {
  teal: 'bg-teal-900/70 text-teal-200',
  fuchsia: 'bg-fuchsia-900/70 text-fuchsia-200',
  violet: 'bg-violet-900/70 text-violet-200',
  indigo: 'bg-indigo-900/70 text-indigo-200',
} as const;

/** 色付きの小さな札。長くなりうる文字は truncate で切る（比較のラベル、外部の説明など） */
export function Tag({ tone, title, truncate = false, children }: { tone: keyof typeof TONE; title?: string; truncate?: boolean; children: ReactNode }) {
  return (
    <span title={title} className={`text-[10px] font-normal px-1.5 py-0.5 rounded ${truncate ? 'max-w-full truncate' : 'shrink-0'} ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export const agentLabel = (s: Pick<Session, 'agent'>): string => (s.agent === 'codex' ? 'Codex' : 'Claude');

/** 外部（VS Code / ターミナル）から観測しているセッションの札 */
export function ExternalTag({ s }: { s: Pick<Session, 'origin' | 'externalHint'> }) {
  if (s.origin !== 'external') return null;
  return <Tag tone="indigo" truncate>{s.externalHint ?? '外部'}</Tag>;
}

/** セッションの性質を表す札の並び: エージェント（Claude 以外のとき）・分離・比較・外部 */
export function SessionTags({ s, agent = true }: { s: Session; agent?: boolean }) {
  return (
    <>
      {agent && s.agent === 'codex' && <Tag tone="teal">{agentLabel(s)}</Tag>}
      {s.workspace && <Tag tone="fuchsia" title={`別の作業場所（コピー）で作業中。ブランチ ${s.workspace.branch}`}>分離</Tag>}
      {s.compare && <Tag tone="violet" truncate title="同じ依頼を複数のモデルに投げて比べています">比較 {s.compare.label}</Tag>}
      <ExternalTag s={s} />
    </>
  );
}
