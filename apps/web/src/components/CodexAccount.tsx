import { useEffect, useState } from 'react';
import { api, errMsg } from '../api';
import { btn } from '../lib';

export function CodexAccount({ onChanged }: { onChanged?: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [login, setLogin] = useState<Awaited<ReturnType<typeof api.codexLogin>>>({ status: 'idle' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (login.status !== 'success') return;
    let active = true;
    api.agents(true).then((a) => { if (active) { setAvailable(a.codex.available); onChanged?.(); } }).catch((e) => active && setError(errMsg(e)));
    return () => { active = false; };
  }, [login.status, onChanged]);
  useEffect(() => {
    let active = true;
    api.agents().then((a) => active && setAvailable(a.codex.available)).catch((e) => active && setError(errMsg(e)));
    api.codexLogin().then((s) => active && setLogin(s)).catch((e) => active && setError(errMsg(e)));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (login.status !== 'waiting') return;
    let active = true;
    const timer = setInterval(() => {
      api.codexLogin().then((s) => {
        if (!active) return;
        if (active) setLogin(s);
      }).catch((e) => active && setError(errMsg(e)));
    }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [login.status, onChanged]);
  return <section aria-label="Codexアカウント" className="rounded-xl border border-zinc-700 bg-sky-400/5 p-3 space-y-2 text-xs">
    <div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-sm">Codexアカウント</h3><span className={available ? 'text-emerald-300' : 'text-amber-300'}>{available === null ? '確認中…' : available ? 'ログイン済み' : '未ログイン'}</span></div>
    <p className="text-zinc-400 leading-relaxed">Towerを動かしているPCのブラウザで、ChatGPTアカウントにログインします。</p>
    <div className="flex flex-wrap gap-2">
      {!available && <button type="button" disabled={busy || login.status === 'waiting'} className={`${btn.base} ${btn.primary}`} onClick={async () => {
        setBusy(true); setError('');
        try { setLogin(await api.codexLogin(true)); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
      }}>{login.status === 'waiting' ? 'ブラウザでのログイン待ち…' : 'Codexにログイン'}</button>}
      <button type="button" disabled={busy} className={`${btn.base} ${btn.ghost}`} onClick={async () => {
        setBusy(true); setError('');
        try { const a = await api.agents(true); setAvailable(a.codex.available); onChanged?.(); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
      }}>状態を再確認</button>
    </div>
    {login.status === 'waiting' && <p role="status" className="text-sky-200">ブラウザで認証を完了すると自動で反映されます。{login.url && <a href={login.url} target="_blank" rel="noreferrer" className="block underline mt-2">ブラウザが開かない場合はこちら</a>}</p>}
    {login.status === 'error' && <p role="alert" className="text-red-300">{login.message}</p>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
    <a href="https://developers.openai.com/codex/auth/" target="_blank" rel="noreferrer" className="inline-block text-zinc-400 underline">公式のログイン手順</a>
  </section>;
}
