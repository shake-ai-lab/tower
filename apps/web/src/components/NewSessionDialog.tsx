import { useEffect, useState } from 'react';
import {
  AGENT_CHOICES,
  CODEX_MODEL_CHOICES,
  MODEL_CHOICES,
  PERMISSION_CHOICES,
  type AgentAvailability,
  type AgentKind,
  type PermissionChoice,
  type ProjectInfo,
} from '@tower/shared';
import { api } from '../api';
import { btn } from '../lib';
import { useStore } from '../store';

export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const select = useStore((s) => s.select);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [agents, setAgents] = useState<Record<AgentKind, AgentAvailability> | null>(null);
  const [projectPath, setProjectPath] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [model, setModel] = useState<string>('');
  const [perm, setPerm] = useState<PermissionChoice>('acceptEdits');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api
      .projects()
      .then((p) => {
        setProjects(p);
        setProjectPath((cur) => cur || p[0]?.path || '');
      })
      .catch((e) => setErr(String(e)));
    api.agents().then(setAgents).catch(() => setAgents(null));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api.create({ projectPath, prompt, agent, model: model || null, permissionMode: perm });
      select(s.id);
      setPrompt('');
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const agentHint = AGENT_CHOICES.find((a) => a.value === agent)?.hint ?? '';
  const agentUnavailable = agents?.[agent]?.available === false ? agents[agent].reason : null;
  const permHint = PERMISSION_CHOICES.find((p) => p.value === perm)?.hint ?? '';
  const modelChoices = agent === 'codex' ? CODEX_MODEL_CHOICES : MODEL_CHOICES;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-4xl rounded-2xl border border-zinc-700 bg-[#12151b] shadow-2xl flex overflow-hidden max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-72 shrink-0 border-r border-zinc-800 flex flex-col">
          <div className="p-3 text-xs text-zinc-500">プロジェクト</div>
          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
            {projects.map((p) => (
              <button
                key={p.path}
                onClick={() => setProjectPath(p.path)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-2 ${projectPath === p.path ? 'bg-sky-600/30 text-sky-100' : 'hover:bg-zinc-800 text-zinc-300'}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${p.hasGit ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
            {projects.length === 0 && (
              <div className="px-3 text-xs text-zinc-500">
                プロジェクトが見つかりません。~/.tower/config.json の projectRoots を設定してください。
              </div>
            )}
          </div>
          <div className="p-2 border-t border-zinc-800">
            <input
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder="フォルダのパスを直接指定"
              className="w-full text-xs mono bg-black/30 border border-zinc-700 rounded px-2 py-1.5 outline-none focus:border-zinc-500"
            />
          </div>
        </div>

        <div className="flex-1 p-4 flex flex-col gap-3 min-w-0">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">新しいタスクを任せる</h2>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-sm">
              閉じる (Esc)
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {AGENT_CHOICES.map((a) => {
              const avail = agents?.[a.value];
              const off = avail?.available === false;
              return (
                <button
                  key={a.value}
                  onClick={() => {
                    setAgent(a.value);
                    setModel('');
                  }}
                  title={off ? avail?.reason : a.hint}
                  className={`${btn.base} ${agent === a.value ? 'bg-sky-600 text-white' : btn.ghost} ${off ? 'opacity-60' : ''}`}
                >
                  {a.label}
                  {off && <span className="ml-1 text-[10px] opacity-80">未ログイン</span>}
                </button>
              );
            })}
            <span className="text-xs text-zinc-500">{agentUnavailable ?? agentHint}</span>
          </div>

          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && prompt.trim() && projectPath) void submit();
            }}
            placeholder={'何をしてほしいか、話すように書いてください。\n例: ログイン画面で空欄のまま送信できてしまうのを直して。直したらテストも通して。'}
            className="flex-1 min-h-[180px] text-sm bg-black/30 border border-zinc-700 rounded-md px-3 py-2 outline-none focus:border-zinc-500 resize-none leading-relaxed"
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="text-xs text-zinc-500 flex items-center gap-2">
              モデル
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="bg-black/30 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200"
              >
                {modelChoices.map((m) => (
                  <option key={m.label} value={m.value ?? ''}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {agent === 'claude' ? (
              <label className="text-xs text-zinc-500 flex items-center gap-2">
                許可
                <select
                  value={perm}
                  onChange={(e) => setPerm(e.target.value as PermissionChoice)}
                  className="bg-black/30 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200"
                >
                  {PERMISSION_CHOICES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="text-xs text-zinc-500">砂場: 作業フォルダ内のみ書き込み可・ネットワーク無し</span>
            )}
            {agent === 'claude' && <span className="text-xs text-zinc-600">{permHint}</span>}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-600">Ctrl+Enter で起動</span>
            <button
              disabled={busy || !prompt.trim() || !projectPath || !!agentUnavailable}
              onClick={submit}
              className={`${btn.base} ${btn.primary} ml-auto px-5`}
            >
              {busy ? '起動中…' : '起動'}
            </button>
          </div>
          {err && <div className="text-xs text-red-400">{err}</div>}
        </div>
      </div>
    </div>
  );
}
