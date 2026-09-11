// 画面からファイルを直す（Monaco）。「たまに自分で直したい」用の最小限の編集画面。
// 保存すると、次に指示を送る時に「このファイルを手で直した」とエージェントへ自動で伝わる（サーバー側で付け足す）。
import { useCallback, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { imageType } from '@tower/shared';
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
  readOnly = false,
  active,
  onDirty,
  windowed = false,
  fontScale = 1,
}: {
  sessionId: string;
  path: string;
  onClose: () => void;
  onSaved?: () => void;
  readOnly?: boolean;
  active: boolean;
  onDirty: (dirty: boolean) => void;
  windowed?: boolean;
  fontScale?: number;
}) {
  const [orig, setOrig] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [zoom, setZoom] = useState('fit');
  const isImage = !!imageType(path);

  useEffect(() => {
    let alive = true;
    setOrig(null);
    setErr(null);
    setSavedAt(null);
    if (isImage) return;
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
  }, [sessionId, path, isImage]);

  const dirty = orig !== null && value !== orig;

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const save = useCallback(async () => {
    if (readOnly || isImage || orig === null || busy || value === orig) return;
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
  }, [sessionId, path, value, orig, busy, onSaved, readOnly, isImage]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        void save();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, save]);

  return (
    <div aria-label={path} className="file-surface h-full min-w-0 bg-[#12151b] flex flex-col overflow-hidden">
        <header className={`file-toolbar ${windowed && isImage ? 'hidden' : 'flex'} flex-wrap items-center gap-2 px-3 py-2 border-b border-zinc-800`}>
          <span className="text-sm text-zinc-400 shrink-0">{isImage ? '画像' : readOnly ? '閲覧' : '直接編集'}</span>
          {!windowed && <span className="mono text-sm text-zinc-100 truncate">{path}</span>}
          {dirty && <span className="text-xs text-amber-300">● 未保存</span>}
          {!dirty && savedAt && <span className="text-xs text-emerald-300">✔ 保存しました {fmtTime(savedAt)}</span>}
          <div className="ml-auto flex gap-1.5">
            {isImage && <select aria-label="画像の倍率" value={zoom} onChange={(e) => setZoom(e.target.value)} className="bg-zinc-800 text-xs rounded px-2">
              <option value="fit">全体表示</option>{['50', '100', '200', '400'].map((n) => <option key={n} value={n}>{n}%</option>)}
            </select>}
            {!isImage && <button disabled={readOnly || !dirty || busy} onClick={save} className={`${btn.base} ${btn.primary} !py-1 !text-xs`}>
              {busy ? '保存中…' : '保存（Ctrl+S）'}
            </button>}
            {!windowed && <button onClick={onClose} className={`${btn.base} ${btn.ghost} !py-1 !text-xs`}>
              閉じる
            </button>}
          </div>
        </header>
        <div className="file-content flex-1 min-h-0">
          {isImage ? (
            <div className="h-full overflow-auto p-4">
              {err ? <p role="alert" className="text-red-300">{err}</p> : <img src={api.rawUrl(sessionId, path)} alt={path} className={windowed || zoom === 'fit' ? "w-full h-full object-contain" : "max-w-none"} style={windowed || zoom === 'fit' ? undefined : { zoom: Number(zoom) / 100 }} onError={() => setErr('画像を表示できません。形式・サイズ（20MBまで）・ファイルの存在を確認してください。')} />}
            </div>
          ) : err && orig === null ? (
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
                fontSize: Math.round(13 * fontScale * 10) / 10,
                readOnly,
                minimap: { enabled: false },
                wordWrap: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderWhitespace: 'selection',
              }}
            />
          )}
        </div>
        <footer className={`${windowed && !err ? 'hidden' : 'flex'} px-4 py-2 border-t border-zinc-800 text-[11px] text-zinc-500 items-center gap-3`}>
          <span>{isImage ? '画像プレビュー' : readOnly ? '作業中・外部タスクのファイルは閲覧のみです。' : '保存すると、次の指示で手動変更をAIに伝えます。テストがあれば裏取りも走ります。'}</span>
          {err && orig !== null && <span className="text-red-300 ml-auto">{err}</span>}
        </footer>
    </div>
  );
}
