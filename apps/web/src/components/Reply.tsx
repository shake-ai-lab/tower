// エージェントの返事（Markdown）を、書き換えずに読みやすく出す。中のファイル名は押すとエディタで開く（画像は画像として）
// React はテスト（node で描く）で JSX に要る
import React, { useMemo, useRef, useState, type MouseEvent } from 'react';
import { api } from '../api';
import { renderReply } from '../markdown';
import { useEditorWorkspace } from '../editor-workspace';

/** 返事の中のファイルを開く手立て。root = タスクの作業フォルダ（workDir）。この外を指すものはリンクにしない */
export type FileLinker = { root: string; open: (path: string, line?: number) => void; imageUrl: (path: string) => string };

/** タスクごとに 1 つ（作り直すと経過の行が全部描き直しになるので、タスクと作業フォルダが変わった時だけ作る） */
export function useFileLinker(id: string, root: string | undefined, onSaved?: () => void): FileLinker | undefined {
  const saved = useRef(onSaved);
  saved.current = onSaved;
  return useMemo(
    () =>
      root
        ? {
            root,
            open: (path: string, line?: number) =>
              useEditorWorkspace.getState().open(id, path, saved.current ? () => saved.current?.() : undefined, line ? { line } : undefined),
            imageUrl: (path: string) => api.rawUrl(id, path),
          }
        : undefined,
    [id, root],
  );
}

const LIMIT = { md: { chars: 1600, lines: 32 }, sm: { chars: 700, lines: 14 } } as const;

/**
 * 返事の本文。長いものは途中までにして「全文を表示」で広げる（clamp = none なら畳まない）。
 * 画面の無い所（node のテスト）では Markdown にせず、そのままの文字で出す
 */
export function ReplyBody({ text, linker, clamp = 'md' }: { text: string; linker?: FileLinker; clamp?: 'md' | 'sm' | 'none' }) {
  const [open, setOpen] = useState(false);
  // 中身の入れ物ごと覚えておく。毎回作り直すと React が表示を差し替え、押している途中のリンクが消えて押せない
  const html = useMemo(
    () => (typeof document === 'undefined' ? null : { __html: renderReply(text, linker ? { root: linker.root, imageUrl: linker.imageUrl } : null) }),
    [text, linker],
  );
  const limit = clamp === 'none' ? null : LIMIT[clamp];
  const long = !!limit && (text.length > limit.chars || text.split('\n').length > limit.lines);
  const clamped = long && !open;

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest('[data-file], a');
    if (!el || !e.currentTarget.contains(el)) return;
    e.preventDefault();
    const file = el.getAttribute('data-file');
    if (file) {
      linker?.open(file, Number(el.getAttribute('data-line')) || undefined);
      return;
    }
    const href = el.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener');
  };

  const cls = ['md-reply', clamped && 'reply-clamped', clamped && clamp === 'sm' && 'reply-clamped-sm'].filter(Boolean).join(' ');
  return (
    <div className="min-w-0">
      {html ? <div className={cls} onClick={onClick} dangerouslySetInnerHTML={html} /> : <div className={`${cls} whitespace-pre-wrap`}>{text}</div>}
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-1 text-xs text-sky-300 hover:text-sky-200 hover:underline">
          {open ? 'たたむ' : '全文を表示'}
        </button>
      )}
    </div>
  );
}
