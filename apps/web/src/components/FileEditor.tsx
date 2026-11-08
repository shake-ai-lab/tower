// 画面からファイルを直す（Monaco）。「たまに自分で直したい」用の編集画面。
// 保存すると、次に指示を送る時に「このファイルを手で直した」とエージェントへ自動で伝わる（サーバー側で付け足す）。
// 行の横には「最後の記録（分離した作業場所なら元のプロジェクト）から変わった行」の印を付ける。Markdown は読みやすく表示できる。
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { imageType, type LineMarksResponse } from '@tower/shared';
import { monaco } from '../monaco';
import { api } from '../api';
import { btn, fmtTime } from '../lib';
import { resolveLink } from '../editor-tools';
import { renderMarkdown } from '../markdown';
import { useEditorWorkspace, type Reveal } from '../editor-workspace';
import { clearDraft, fileKey, fingerprint, readDraft, writeDraft } from '../editor-persist';

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
  markdown: 'markdown',
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

const MARK_COLOR = { added: '#3fb950', modified: '#388bfd', deleted: '#f85149' } as const;

/** 書きかけを取った時刻。今日なら時刻だけ、前の日なら日付も */
const draftTime = (ts: number) =>
  new Date(ts).toDateString() === new Date().toDateString()
    ? fmtTime(ts)
    : new Date(ts).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

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
  reveal,
  focusRequest,
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
  /** 検索結果などから開いた時に見せる場所 */
  reveal?: Reveal;
  /** 名前で開く操作ごとに変わる。既に開いているファイルでも入力先を戻す。 */
  focusRequest?: number;
}) {
  const [orig, setOrig] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [zoom, setZoom] = useState('fit');
  const isImage = !!imageType(path);
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const [mode, setMode] = useState<'preview' | 'edit'>(isMarkdown ? 'preview' : 'edit');
  const [marks, setMarks] = useState<LineMarksResponse | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const revealed = useRef(0);
  const [ready, setReady] = useState(false);
  const key = fileKey(sessionId, path);
  // 前回保存していなかった書きかけ（editor-persist）: restored＝戻した / changed＝その後ファイルが変わった / busy＝作業中で閲覧のみ
  const [draftNote, setDraftNote] = useState<{ kind: 'restored' | 'changed' | 'busy'; value: string; at: number } | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  useEffect(() => {
    let alive = true;
    setOrig(null);
    setErr(null);
    setSavedAt(null);
    setDraftNote(null);
    if (isImage) return;
    api
      .file(sessionId, path)
      .then((f) => {
        if (!alive) return;
        const id = fileKey(sessionId, path);
        const d = readDraft(id);
        setOrig(f.content);
        if (!d || d.value === f.content) {
          setValue(f.content);
          if (d) clearDraft(id);
          return;
        }
        // 読み込んだ時の中身から変わっていなければそのまま戻す。変わっていた・作業中で閲覧のみなら、戻すかどうかを選んでもらう
        const kind = d.base !== fingerprint(f.content) ? 'changed' : readOnlyRef.current ? 'busy' : 'restored';
        setValue(kind === 'restored' ? d.value : f.content);
        setDraftNote({ kind, value: d.value, at: d.at });
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [sessionId, path, isImage]);

  // 変わった行の印。保存したら取り直す（打っている間の行のずれは Monaco が印ごと動かす）
  useEffect(() => {
    if (isImage) return;
    let alive = true;
    api
      .lineMarks(sessionId, path)
      .then((r) => alive && setMarks(r))
      .catch(() => alive && setMarks(null));
    return () => {
      alive = false;
    };
  }, [sessionId, path, isImage, savedAt]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !ready) return;
    decorations.current ??= ed.createDecorationsCollection();
    decorations.current.set(
      (marks?.marks ?? []).map((m) => ({
        range: new monaco.Range(m.start, 1, m.end, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `line-mark line-mark-${m.kind}`,
          overviewRuler: { color: MARK_COLOR[m.kind], position: monaco.editor.OverviewRulerLane.Left },
        },
      })),
    );
  }, [marks, ready]);

  // 検索結果から開いた時: その行を真ん中に出して、見つかった文字を選ぶ
  useEffect(() => {
    const ed = editorRef.current;
    if (!reveal || !ed || !ready || revealed.current === reveal.at) return;
    revealed.current = reveal.at;
    setMode('edit');
    // Markdown の表示から切り替えた直後は大きさが 0 なので、描き直してから動かす
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        ed.layout();
        const range = new monaco.Range(reveal.line, reveal.column, reveal.line, reveal.column + reveal.length);
        ed.revealRangeInCenter(range);
        ed.setSelection(range);
        ed.focus();
      }),
    );
  }, [reveal, ready]);

  const onMount = useCallback<OnMount>((ed) => {
    editorRef.current = ed;
    decorations.current = null;
    setReady(true);
  }, []);

  const dirty = orig !== null && value !== orig;

  // エディタへ渡す設定と受け口は、中身が変わった時だけ作り直す。毎回新しく作ると、
  // ほかのタスクの知らせが来るたびに開いている全部のエディタが設定をやり直していた
  const options = useMemo<monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      fontSize: Math.round(13 * fontScale * 10) / 10,
      readOnly,
      minimap: { enabled: false },
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderWhitespace: 'selection',
    }),
    [fontScale, readOnly],
  );
  const onChange = useCallback((v: string | undefined) => setValue(v ?? ''), []);

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // 保存していない書きかけを端末に残す（再起動・入れ直しのあとに戻せるように）。前回の書きかけを戻すか決まるまでは触らない
  const undecided = draftNote !== null && draftNote.kind !== 'restored';
  useEffect(() => {
    if (orig === null || isImage || undecided) return;
    if (value === orig) {
      clearDraft(key);
      return;
    }
    const t = setTimeout(() => writeDraft(key, orig, value), 300);
    const flush = () => {
      clearTimeout(t);
      writeDraft(key, orig, value);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pagehide', flush);
    };
  }, [key, orig, value, isImage, undecided]);

  const save = useCallback(async () => {
    if (readOnly || isImage || orig === null || busy || value === orig) return;
    setBusy(true);
    setErr(null);
    try {
      await api.saveFile(sessionId, { path, content: value });
      setOrig(value);
      setSavedAt(Date.now());
      setDraftNote((n) => (n?.kind === 'restored' ? null : n));
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

  const preview = isMarkdown && mode === 'preview';
  useEffect(() => {
    if (!active || !ready || preview) return;
    const frame = requestAnimationFrame(() => {
      // 読み込み中に別のダイアログを開いた場合は入力を奪わない。
      if (document.querySelector('[role="dialog"]')) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') && !focused.closest('.monaco-editor')) return;
      editorRef.current?.layout();
      editorRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, ready, preview, focusRequest]);
  // 中身の入れ物ごと覚えておく。毎回作り直すと React が表示を差し替え、押している途中のリンクが消えて押せない
  const html = useMemo(
    () => ({ __html: preview && orig !== null ? renderMarkdown(value, path, (p) => api.rawUrl(sessionId, p)) : '' }),
    [preview, orig, value, path, sessionId],
  );

  // 表示の中のリンク: 外のページは別の窓（デスクトップ版はいつものブラウザ）、プロジェクトの中のファイルはここで開く
  const onPreviewClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener');
    else {
      const target = resolveLink(path, href);
      if (target) useEditorWorkspace.getState().open(sessionId, target);
    }
  };

  // 隣り合う「変えた行」「足した行」は 1 か所に数える
  const blocks = (marks?.marks ?? []).reduce((n, m, i, all) => n + (i > 0 && m.start <= all[i - 1].end + 1 ? 0 : 1), 0);
  const nextChange = () => {
    const ed = editorRef.current;
    const starts = [...new Set(decorations.current?.getRanges().map((r) => r.startLineNumber) ?? [])].sort((a, b) => a - b);
    if (!ed || !starts.length) return;
    const current = ed.getPosition()?.lineNumber ?? 0;
    const line = starts.find((l) => l > current) ?? starts[0];
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  };

  return (
    <div aria-label={path} className="file-surface h-full min-w-0 bg-[#12151b] flex flex-col overflow-hidden">
        <header className={`file-toolbar ${windowed && isImage ? 'hidden' : 'flex'} flex-wrap items-center gap-2 px-3 py-2 border-b border-zinc-800`}>
          <span className="text-sm text-zinc-400 shrink-0">{isImage ? '画像' : readOnly ? '閲覧' : '直接編集'}</span>
          {!windowed && <span className="mono text-sm text-zinc-100 truncate">{path}</span>}
          {dirty && <span className="text-xs text-amber-300">● 未保存</span>}
          {!dirty && savedAt && <span className="text-xs text-emerald-300">✔ 保存しました {fmtTime(savedAt)}</span>}
          {blocks > 0 && !preview && (
            <button
              title={`${marks?.against}から変わった行に印を付けています。緑＝足した行、青＝変えた行、赤い三角＝その下で行を消した。押すと次の変わった所へ移ります`}
              onClick={nextChange}
              className="text-xs text-sky-300 hover:underline"
            >
              変わった所 {blocks} か所 ↓
            </button>
          )}
          {/* 狭い欄では、ボタンの文字を途中で折らずにボタンごと次の行へ送る */}
          <div className="ml-auto flex flex-wrap justify-end gap-1.5">
            {isMarkdown && orig !== null && (
              <div role="group" aria-label="Markdown の表示" className="flex shrink-0 overflow-hidden rounded border border-zinc-700 text-xs">
                {(['preview', 'edit'] as const).map((m) => (
                  <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)} className={`whitespace-nowrap px-2 py-0.5 ${mode === m ? 'bg-sky-900 text-sky-100' : 'text-zinc-400 hover:bg-zinc-800'}`}>
                    {m === 'preview' ? '読みやすく表示' : readOnly ? '文字のまま' : '編集'}
                  </button>
                ))}
              </div>
            )}
            {isImage && <select aria-label="画像の倍率" value={zoom} onChange={(e) => setZoom(e.target.value)} className="bg-zinc-800 text-xs rounded px-2">
              <option value="fit">全体表示</option>{['50', '100', '200', '400'].map((n) => <option key={n} value={n}>{n}%</option>)}
            </select>}
            {!isImage && <button disabled={readOnly || !dirty || busy} onClick={save} className={`${btn.base} ${btn.primary} whitespace-nowrap !py-1 !text-xs`}>
              {busy ? '保存中…' : '保存（Ctrl+S）'}
            </button>}
            {!windowed && <button onClick={onClose} className={`${btn.base} ${btn.ghost} whitespace-nowrap !py-1 !text-xs`}>
              閉じる
            </button>}
          </div>
        </header>
        {draftNote && (
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b border-amber-900/60 bg-amber-950/40 text-xs text-amber-200">
            <span>
              {draftNote.kind === 'restored'
                ? `前回保存していなかった変更（${draftTime(draftNote.at)}）を戻しました。まだ保存していません。`
                : draftNote.kind === 'changed'
                  ? `前回保存していなかった変更（${draftTime(draftNote.at)}）があります。その後ファイルが変わったので、自動では戻していません。戻すと、今の中身がその時の書きかけに置き換わります（保存するまでファイルは変わりません）。`
                  : `前回保存していなかった変更（${draftTime(draftNote.at)}）があります。タスクが作業中で今は閲覧のみなので、終わったら戻せます。`}
            </span>
            <div className="ml-auto flex gap-3">
              {draftNote.kind === 'restored' ? (
                <>
                  <button className="hover:underline" onClick={() => { setValue(orig ?? ''); setDraftNote(null); }}>変更を捨てる</button>
                  <button className="hover:underline" onClick={() => setDraftNote(null)}>閉じる</button>
                </>
              ) : (
                <>
                  <button disabled={readOnly} className="hover:underline disabled:opacity-40 disabled:no-underline" onClick={() => { setValue(draftNote.value); setDraftNote(null); }}>書きかけを戻す</button>
                  <button className="hover:underline" onClick={() => { clearDraft(key); setDraftNote(null); }}>捨てる</button>
                </>
              )}
            </div>
          </div>
        )}
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
            <>
              {preview && (
                <div className="h-full overflow-auto" onClick={onPreviewClick}>
                  <article aria-label={`${path} の表示`} className="md-preview" dangerouslySetInnerHTML={html} />
                </div>
              )}
              {/* Markdown を表示している間もエディタは残す（印・選択・未保存の中身をそのまま保つ） */}
              <div className={preview ? 'hidden' : 'h-full'}>
                <Editor
                  height="100%"
                  theme="vs-dark"
                  language={langOf(path)}
                  value={value}
                  onChange={onChange}
                  onMount={onMount}
                  loading={<div className="p-4 text-sm text-zinc-500">エディタを準備中…</div>}
                  options={options}
                />
              </div>
            </>
          )}
        </div>
        <footer className={`${windowed && !err ? 'hidden' : 'flex'} px-4 py-2 border-t border-zinc-800 text-[11px] text-zinc-500 items-center gap-3`}>
          <span>{isImage ? '画像プレビュー' : preview ? '見出し・表・チェック欄を整えて表示しています。リンクを押すと、そのファイルを開きます。' : readOnly ? 'エージェントが作業している間は閲覧のみです。終わると直せます。' : '保存すると、次に Tower から指示を送る時、手で直したことを AI に伝えます。テストがあれば裏取りも走ります。'}</span>
          {err && orig !== null && <span className="text-red-300 ml-auto">{err}</span>}
        </footer>
    </div>
  );
}
