import { useEffect, useState } from 'react';
import type { SettingsStatus, TowerSettings } from '@tower/shared';
import { api, errMsg } from '../api';
import { btn, clearSavedWidths } from '../lib';
import { CodexAccount } from './CodexAccount';

const CHECKBOX_LABELS = {
  autoVerify: '報告後にテストを自動実行',
  reformatReports: '報告をAIで読みやすく整形',
  autoResume: '再起動で止まったタスクを自動で再開',
  autoCommit: '報告のたびに変更を記録（コミット）',
} as const;

export function SettingsPanel() {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [draft, setDraft] = useState<TowerSettings | null>(null);
  const [roots, setRoots] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.settings().then((s) => {
      if (!active) return;
      setStatus(s); setDraft(s.settings); setRoots(s.settings.projectRoots.join('\n'));
    }).catch((e) => active && setError(errMsg(e)));
    return () => { active = false; };
  }, []);
  const input = 'w-full mt-1 rounded border border-zinc-700 bg-zinc-900 p-2 text-sm';
  return <form className="p-2 space-y-2 text-sm" onSubmit={async (e) => {
    e.preventDefault();
    if (!draft || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const s = await api.saveSettings({ ...draft, projectRoots: roots.split(/\r?\n/).map((r) => r.trim()).filter(Boolean) });
      setStatus(s); setDraft(s.settings); setRoots(s.settings.projectRoots.join('\n')); setMessage('保存しました');
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }}>
    <h2 className="font-semibold">設定</h2>
    <CodexAccount />
    {error && <p role="alert" className="text-red-300 break-words">{error}</p>}
    {!draft ? <p>設定を読み込み中…</p> : <fieldset disabled={busy} className="space-y-3 min-w-0">
      <label className="block">プロジェクトの親フォルダ（1行に1つ）<textarea className={input} rows={4} value={roots} onChange={(e) => setRoots(e.target.value)} /></label>
      {(['autoVerify', 'reformatReports', 'autoResume', 'autoCommit'] as const).map((key) => <label key={key} className="flex gap-2 items-center">
        <input type="checkbox" checked={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} />
        {CHECKBOX_LABELS[key]}
      </label>)}
      <label className="block">外部タスクの保持時間（時間・0は無期限）<input className={input} type="number" min={0} max={720} required value={draft.externalKeepHours} onChange={(e) => setDraft({ ...draft, externalKeepHours: Number(e.target.value) })} /></label>
      <label className="block">外部の許可を待つ時間（秒）<input className={input} type="number" min={10} max={600} required value={draft.bridgeWaitSeconds} onChange={(e) => setDraft({ ...draft, bridgeWaitSeconds: Number(e.target.value) })} /></label>
      <label className="block">「気づいたこと」の保存先<input className={input} required value={draft.feedbackFile} onChange={(e) => setDraft({ ...draft, feedbackFile: e.target.value })} /></label>
      <details><summary className="cursor-pointer">接続設定（反映には再起動）</summary>
        <label className="block mt-2">待ち受けアドレス<input className={input} required value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} /></label>
        <label className="block mt-2">ポート<input className={input} type="number" min={1} max={65535} required value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
      </details>
      <button className={`${btn.base} ${btn.primary}`} type="submit">{busy ? '保存中…' : '設定を保存'}</button>
      {message && <p role="status" className="text-emerald-300">{message}</p>}
    </fieldset>}
    {!!status?.needsRestart.length && <p className="text-amber-300">再起動で反映: {status.needsRestart.join('、')}</p>}
    <button type="button" className={`${btn.base} ${btn.ghost}`} onClick={clearSavedWidths}>パネル幅を元に戻す</button>
    <p className="text-xs text-zinc-500 break-all">{status?.file}<br />Tower {status?.version}</p>
  </form>;
}
