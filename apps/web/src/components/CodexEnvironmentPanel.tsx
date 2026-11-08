import { useEffect, useState } from 'react';
import type { ProjectInfo } from '@tower/shared';
import { api, errMsg, type CodexEnvironment, type CodexInventory } from '../api';
import { btn } from '../lib';

const runtimeNames: Record<string, string> = {
  notStarted: '未起動', starting: '接続中', connected: '接続済み', authenticationRequired: '認証が必要',
  failed: '接続失敗', cancelled: '接続中止', disabled: '無効',
};
const authNames: Record<string, string> = { unknown: '認証状態不明', unsupported: 'OAuth対象外', notLoggedIn: '未ログイン', bearerToken: 'トークン設定あり', oAuth: 'OAuth認証あり' };
const disabledNames: Record<string, string> = { disabled_by_admin: '管理者により無効', plan_not_eligible: '契約プラン対象外', required_app_unavailable: '必要なアプリが未接続', unknown: '利用不可' };

function InventoryNotice({ inventory }: { inventory: CodexInventory<unknown> }) {
  return <>
    {inventory.status === 'ready' && inventory.items.length === 0 && <p className="text-zinc-500">登録はありません。</p>}
    {inventory.issues.map((issue, i) => <p key={i} role="status" className="text-amber-300">{issue}</p>)}
  </>;
}

export function CodexEnvironmentPanel() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [cwd, setCwd] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<CodexEnvironment | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showUninstalled, setShowUninstalled] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void api.projects().then((items) => { if (active) setProjects(items); }).catch(() => {});
    return () => { active = false; };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError(''); setData(null);
    void api.codexEnvironment(attempt > 0, cwd).then((result) => { if (active) setData(result); })
      .catch((e) => { if (active) setError(errMsg(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, cwd, attempt]);
  return <details className="border border-zinc-700 rounded p-2" onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">Codexのスキル・MCP・プラグイン</summary>
    {open && <div className="mt-2 space-y-3 text-xs">
      <p className="text-zinc-400">実際のCodexから読み込んだ一覧を確認します。プロジェクトごとのスキルや接続設定も確認できます。</p>
      <label className="block">確認するプロジェクト
        <select aria-label="Codex環境のプロジェクト" value={cwd} onChange={(e) => setCwd(e.target.value)} className="w-full mt-1 border border-zinc-700 bg-zinc-900 rounded p-1">
          <option value="">共通設定（ホームフォルダ）</option>
          {projects.map((project) => <option key={project.path} value={project.path}>{project.name} — {project.path}</option>)}
        </select>
      </label>
      <button type="button" disabled={loading} className={`${btn.base} ${btn.ghost}`} onClick={() => setAttempt((n) => n + 1)}>一覧を再取得</button>
      {loading && <p role="status">Codexの環境を確認しています…</p>}
      {error && <p role="alert" className="text-red-300">{error}</p>}
      {data && <>
        <p className="text-zinc-500 break-all">確認先: {data.cwd}<br />確認時刻: {new Date(data.checkedAt).toLocaleTimeString()}</p>
        <section aria-label="Codexスキル一覧">
          <h3 className="font-medium mb-1">スキル（{data.skills.items.length}）</h3>
          <InventoryNotice inventory={data.skills} />
          <ul className="space-y-1">{data.skills.items.map((skill, i) => <li key={`${skill.path}-${i}`} title={skill.path} className="break-words">
            <span className={skill.enabled ? 'text-zinc-200' : 'text-zinc-500'}>{skill.name}</span>
            <span className="text-zinc-500"> — {skill.enabled ? '有効' : '無効'}・{skill.scope}{skill.pluginId ? `・${skill.pluginId}` : ''}</span>
          </li>)}</ul>
        </section>
        <section aria-label="Codex MCP一覧">
          <h3 className="font-medium mb-1">MCP（{data.mcp.items.length}）</h3>
          <p className="text-zinc-500 mb-1">接続状態が未確認の場合、タスク実行時の接続成功はまだ確認していません。道具の件数にはキャッシュが含まれる場合があります。</p>
          <InventoryNotice inventory={data.mcp} />
          <ul className="space-y-2">{data.mcp.items.map((server, i) => <li key={`${server.name}-${i}`} className="break-words">
            <p className="text-zinc-200">{server.name} — {server.runtimeStatus ? runtimeNames[server.runtimeStatus] ?? '状態不明' : '接続状態未確認'}</p>
            <p className="text-zinc-500">{authNames[server.authStatus] ?? '認証状態不明'}{server.pluginId ? `・${server.pluginId}` : ''}</p>
            {server.issue && <p className="text-amber-300">{server.issue}</p>}
            <details><summary className="cursor-pointer text-zinc-400">道具（{server.tools.length}）</summary><ul className="pl-3">{server.tools.map((tool) => <li key={tool}>{tool}</li>)}</ul></details>
          </li>)}</ul>
        </section>
        <section aria-label="Codexプラグイン一覧">
          <h3 className="font-medium mb-1">プラグイン（インストール済み {data.plugins.items.filter((p) => p.installed).length}）</h3>
          <p className="text-zinc-500 mb-1">ローカルの一覧です。リモートカタログの再取得やインストールは行いません。</p>
          <InventoryNotice inventory={data.plugins} />
          <label className="flex gap-1 items-center my-1"><input type="checkbox" checked={showUninstalled} onChange={(e) => setShowUninstalled(e.target.checked)} />未インストールも表示</label>
          <ul className="space-y-1">{data.plugins.items.filter((p) => showUninstalled || p.installed).map((plugin, i) => <li key={`${plugin.id}-${i}`} className="break-words">
            {plugin.name} — {plugin.installed ? plugin.enabled ? '有効' : '無効' : '未インストール'}
            {plugin.disabledReason && <span className="text-amber-300">・{disabledNames[plugin.disabledReason] ?? '利用不可'}</span>}
            <span className="text-zinc-500">・{plugin.marketplace}</span>
          </li>)}</ul>
        </section>
      </>}
    </div>}
  </details>;
}
