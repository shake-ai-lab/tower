import { useCallback, useEffect, useRef, useState } from 'react';
import { FEEDBACK_KINDS, type FeedbackContext, type FeedbackKind, type FeedbackNote } from '@tower/shared';
import { api } from '../api';
import { btn } from '../lib';

const KIND_CLS: Record<FeedbackKind, string> = {
  complaint: 'bg-amber-900/70 text-amber-200',
  request: 'bg-sky-900/70 text-sky-200',
  bug: 'bg-red-900/70 text-red-200',
  praise: 'bg-emerald-900/70 text-emerald-200',
};

const PLACEHOLDER: Record<FeedbackKind, string> = {
  complaint: '例: 許可のカードの文字が小さくて読みにくい',
  request: '例: 報告が来たら音でも知らせてほしい',
  bug: '例: 「取り込む」を押しても何も起きなかった',
  praise: '例: 修正前と修正後の対比が分かりやすい',
};

const label = (k: FeedbackKind) => FEEDBACK_KINDS.find((x) => x.value === k)?.label ?? k;

function fmtDay(ts: number) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 「気づいたこと」: 使いながら不満・要望・不具合を一言で書き残す。
 * サーバーが Markdown（設定 feedbackFile）に追記し、Claude Code に「気づいたことに対応して」と頼むとそれを読んで直す。
 * 見ていた画面は「開いた時点」のものを添える（書いている間に画面が変わっても、気になった場面が残る）
 */
export function FeedbackMenu({
  open,
  onOpenChange,
  scene,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  scene: () => FeedbackContext;
}) {
  const [kind, setKind] = useState<FeedbackKind>('complaint');
  const [text, setText] = useState('');
  const [attach, setAttach] = useState(true);
  const [ctx, setCtx] = useState<FeedbackContext>({});
  const [notes, setNotes] = useState<FeedbackNote[]>([]);
  const [file, setFile] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(() => {
    api
      .feedback()
      .then((r) => {
        setNotes(r.notes);
        setFile(r.file);
        setVersion(r.version);
      })
      .catch(() => {
        /* 古いサーバーなど。ボタンは出すが件数は無し */
      });
  }, []);
  // 起動時に一度読んで、未対応の件数をボタンに出す
  useEffect(load, [load]);

  useEffect(() => {
    if (!open) return;
    setCtx(scene());
    setError(null);
    load();
    const t = setTimeout(() => area.current?.focus(), 0);
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const n = await api.addFeedback({ kind, text: t, context: attach ? ctx : undefined });
      setNotes((cur) => [...cur, n]);
      setText('');
      setFlash('書き残しました');
      setTimeout(() => setFlash(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      area.current?.focus();
    }
  };

  const del = async (id: string) => {
    try {
      await api.removeFeedback(id);
      setNotes((cur) => cur.filter((n) => n.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openCount = notes.filter((n) => !n.done).length;
  const recent = [...notes].reverse().slice(0, 30);

  return (
    <div className="relative" ref={root}>
      <button
        onClick={() => onOpenChange(!open)}
        className={`${btn.base} ${btn.ghost} !text-xs whitespace-nowrap`}
        title="使っていて気になったことを一言で書き残す（キー f）。Claude Code が後で読んで直します"
      >
        <span className="sm:hidden">✎</span>
        <span className="hidden sm:inline">気づいたこと</span>
        {openCount > 0 && <span className="ml-1 px-1.5 rounded-full bg-zinc-700 text-zinc-200">{openCount}</span>}
      </button>
      {open && (
        <div
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onOpenChange(false);
            }
          }}
          className="fixed left-2 right-2 top-14 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-1 sm:w-[min(520px,calc(100vw-1rem))] max-h-[calc(100vh-4rem)] overflow-y-auto rounded-lg border border-zinc-700 bg-[#171a21] shadow-xl p-3 text-sm z-50 space-y-3"
        >
          <div className="flex flex-wrap gap-1.5">
            {FEEDBACK_KINDS.map((k) => (
              <button
                key={k.value}
                onClick={() => setKind(k.value)}
                title={k.hint}
                className={`px-2.5 py-1 rounded-full text-xs border transition ${
                  kind === k.value ? `${KIND_CLS[k.value]} border-transparent font-semibold` : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
          <textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={3}
            placeholder={PLACEHOLDER[kind]}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-sky-600 resize-y"
          />
          <label className="flex items-start gap-2 text-xs text-zinc-400 cursor-pointer">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} className="mt-0.5" />
            <span>
              見ていた画面を添える: <span className="text-zinc-300">{ctx.view ?? '一覧'}</span>
            </span>
          </label>
          <div className="flex items-center gap-2">
            <button onClick={() => void submit()} disabled={!text.trim() || busy} className={`${btn.base} ${btn.primary}`}>
              書き残す <span className="opacity-60 text-xs ml-1">Ctrl+Enter</span>
            </button>
            {flash && <span className="text-xs text-emerald-300">{flash}</span>}
            {error && <span className="text-xs text-red-300">{error}</span>}
          </div>
          {recent.length > 0 && (
            <div className="border-t border-zinc-800 pt-2">
              <div className="text-xs text-zinc-500 mb-1">
                これまでに書いたもの{openCount > 0 && `（未対応 ${openCount} 件）`}
              </div>
              <ul className="space-y-1.5">
                {recent.map((n) => (
                  <li key={n.id} className={`text-xs rounded-md px-2 py-1.5 bg-zinc-900/60 ${n.done ? 'opacity-60' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className={`px-1.5 rounded ${KIND_CLS[n.kind]}`}>{label(n.kind)}</span>
                      <span className="text-zinc-500">{fmtDay(n.createdAt)}</span>
                      {n.done && <span className="text-emerald-300">✔ 対応済み</span>}
                      {!n.done && (
                        <button onClick={() => void del(n.id)} title="書き間違いなどを消す" className="ml-auto text-zinc-600 hover:text-red-300">
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="text-zinc-200 whitespace-pre-wrap break-words mt-0.5">{n.text}</div>
                    {n.scene && (
                      <div className="text-zinc-500 truncate" title={n.scene}>
                        場面: {n.scene}
                      </div>
                    )}
                    {n.resolution && <div className="text-emerald-200/80">対応: {n.resolution}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-zinc-500 leading-relaxed">
            何を見ていて、何に困ったかを一言で。Claude Code に「気づいたことに対応して」と頼むと、ここに書いたものを読んで直します。
            {file && (
              <>
                <br />
                保存先: <span className="text-zinc-400 break-all">{file}</span>
                {version && ` · Tower ${version}`}
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
