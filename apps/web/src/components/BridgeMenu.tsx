import { useEffect, useState } from 'react';
import type { BridgeStatus } from '@tower/shared';
import { api, errMsg } from '../api';
import { btn } from '../lib';

/** VS Code / ターミナルで動く Claude Code を Tower に取り込む設定 */
export function BridgeMenu() {
  const [st, setSt] = useState<BridgeStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [keepHours, setKeepHours] = useState<number | null>(null);

  const load = () => api.bridge().then(setSt).catch((e) => setErr(errMsg(e)));
  useEffect(() => {
    void load();
    api.config().then((c) => setKeepHours(c.externalKeepHours ?? 0)).catch(() => {});
  }, []);

  const apply = async (enabled: boolean, permissions: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      setSt(await api.setBridge({ enabled, permissions }));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const on = st?.installed ?? false;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`${btn.base} ${on ? 'bg-indigo-700 hover:bg-indigo-600 text-white' : btn.ghost} !text-xs`}
        title="VS Code 拡張やターミナルで動かしている Claude Code をここに表示する"
      >
        VS Code 連携: {on ? 'オン' : 'オフ'}
      </button>
      {open && (
        <div
          className="absolute right-0 mt-2 w-[min(380px,calc(100vw-2rem))] z-40 rounded-xl border border-zinc-700 bg-[#12151b] shadow-2xl p-4 space-y-3 text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="font-semibold">VS Code / ターミナル連携</div>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Claude Code の hooks を使って、Tower の外で動いているセッションもカードとして表示します。
            設定は <span className="mono">{st?.settingsPath ?? '~/.claude/settings.json'}</span> に書き込みます（他の設定はそのまま。バックアップも残します）。
          </p>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={on}
              disabled={busy}
              onChange={(e) => apply(e.target.checked, e.target.checked && (st?.permissions ?? false))}
              className="mt-1"
            />
            <span>
              <span className="font-medium">外のセッションを表示する</span>
              <span className="block text-xs text-zinc-500">起動・指示・作業内容・停止・許可待ちを観測します</span>
            </span>
          </label>
          <label className={`flex items-start gap-2 ${on ? 'cursor-pointer' : 'opacity-50'}`}>
            <input
              type="checkbox"
              checked={st?.permissions ?? false}
              disabled={busy || !on}
              onChange={(e) => apply(true, e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">許可も Tower で答える</span>
              <span className="block text-xs text-zinc-500">
                外のセッションの許可要求もインボックスに出て、ここで許可/拒否できます。
                {st?.waitSeconds ?? 90}秒以内に答えないと元の画面の許可ダイアログに戻ります（その間、元の画面は待ちになります）。
              </span>
            </span>
          </label>
          <p className="text-xs text-zinc-500 leading-relaxed">
            外のセッションに Tower から指示を送ると、Tower が会話を引き継いで続きを動かします。元の画面で同時に動かさないでください。
          </p>
          <p className="text-xs text-zinc-500 leading-relaxed">
            外のセッションの報告は決まった書式が無いので、Tower が AI で読みやすく整形します（カードに「Tower が整形」と付きます）。
            {keepHours !== null &&
              (keepHours > 0
                ? ` 最後の動きから ${keepHours} 時間たったものは一覧から自動で消えます（また動けば戻ります）。`
                : ' 自動では消えません（設定の externalKeepHours で変えられます）。')}
          </p>
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex justify-end">
            <button onClick={() => setOpen(false)} className={`${btn.base} ${btn.ghost} !text-xs`}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
