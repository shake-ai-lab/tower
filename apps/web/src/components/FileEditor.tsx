// 画面からファイルを直す（Monaco）。「たまに自分で直したい」用の最小限の編集画面。
// 保存すると、次に指示を送る時に「このファイルを手で直した」とエージェントへ自動で伝わる（サーバー側で付け足す）。
import { useCallback, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import '../monaco';
import { api } from '../api';
import { btn, fmtTime } from '../lib';

const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  py: 'python',
  rs: 'rust',
  go: 'go',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  java: 'java',
  cs: 'csharp',
  xml: 'xml',
  svg: 'xml',
};

function langOf(p: string): string {
  const name = p.split('/').pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return LANG[ext] ?? 'plaintext';
}

export function FileEditor({
  sessionId,
  path,
  onClose,
  onSaved,
}: {
  sessionId: string;
  path: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [orig, setOrig] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setOrig(null);
    setErr(null);
    api
      .file(sessionId, path)
      .then((f) => {
        if (!alive) return;
        setOrig(f.content);
        setValue(f.content);
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [sessionId, path]);

  const dirty = orig !== null && value !== orig;

  const save = useCallback(async () => {
    if (orig === null || busy || value === orig) return;
    setBusy(true);
    setErr(null);
    try {
      await api.saveFile(sessionId, { path, content: value });
      setOrig(value);
      setSavedAt(Date.now());
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, path, value, orig, busy, onSaved]);

  const close = useCallback(() => {
    if (dirty && !confirm('保存していない変更があります。閉じますか？')) return;
    onClose();
  }, [dirty, onClose]);

  // Esc で閉じる、Ctrl+S で保存。捕捉段階で止めて、後ろの画面（Esc で詳細を閉じる等）に届かないようにする
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        void save();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close, save]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6" onClick={close}>
      <div
        className="w-full max-w-5xl h-[85vh] rounded-xl border border-zinc-700 bg-[#12151b] shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800">
          <span className="text-sm text-zinc-400">直接編集</span>
          <span className="mono text-sm text-zinc-100 truncate">{path}</span>
          {dirty && <span className="text-xs text-amber-300">● 未保存</span>}
          {!dirty && savedAt && <span className="text-xs text-emerald-300">✔ 保存しました {fmtTime(savedAt)}</span>}
          <div className="ml-auto flex gap-1.5">
            <button disabled={!dirty || busy} onClick={save} className={`${btn.base} ${btn.primary} !py-1 !text-xs`}>
              {busy ? '保存中…' : '保存（Ctrl+S）'}
            </button>
            <button onClick={close} className={`${btn.base} ${btn.ghost} !py-1 !text-xs`}>
              閉じる
            </button>
          </div>
        </header>
        <div className="flex-1 min-h-0">
          {err && orig === null ? (
            <div className="p-4 text-sm text-red-300">{err}</div>
          ) : orig === null ? (
            <div className="p-4 text-sm text-zinc-500">読み込み中…</div>
          ) : (
            <Editor
              height="100%"
              theme="vs-dark"
              language={langOf(path)}
              value={value}
              onChange={(v) => setValue(v ?? '')}
              loading={<div className="p-4 text-sm text-zinc-500">エディタを準備中…</div>}
              options={{
                fontSize: 13,
                minimap: { enabled: false },
                wordWrap: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderWhitespace: 'selection',
              }}
            />
          )}
        </div>
        <footer className="px-4 py-2 border-t border-zinc-800 text-[11px] text-zinc-500 flex items-center gap-3">
          <span>保存すると、次に指示を送る時に「このファイルを手で直した」と AI に自動で伝わります。テストがあれば裏取りも走ります。</span>
          {err && orig !== null && <span className="text-red-300 ml-auto">{err}</span>}
        </footer>
      </div>
    </div>
  );
}
