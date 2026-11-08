import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AGENT_CHOICES,
  CODEX_PERMISSION_CHOICES,
  MODEL_CHOICES,
  PERMISSION_CHOICES,
  type AgentAvailability,
  type AgentKind,
  type PermissionChoice,
  type ProjectInfo,
} from '@tower/shared';
import { api, errMsg, type CodexModelCatalog } from '../api';
import { btn, isAlive } from '../lib';
import { useStore } from '../store';
import { openTask } from '../layout';
import { Icon } from './Icon';
import { CodexAccount } from './CodexAccount';
import { projectKey } from '../project-key';
import { AttachButton, AttachList, useAttachments } from './Attachments';

export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  // フォルダ一覧を移動しても、選択した子フォルダのGit情報を失わない。
  const [projectInfo, setProjectInfo] = useState<Record<string, ProjectInfo>>({});
  const rememberProjects = useCallback((items: ProjectInfo[]) => {
    setProjectInfo(current => ({ ...current, ...Object.fromEntries(items.map(item => [projectKey(item.path), item])) }));
  }, []);
  const [agents, setAgents] = useState<Record<AgentKind, AgentAvailability> | null>(null);
  const [projectPath, setProjectPath] = useState('');
  const [browse, setBrowse] = useState<{ path: string; parent: string | null; projects: ProjectInfo[] } | null>(null);
  const [query, setQuery] = useState('');
  const [loadingFolders, setLoadingFolders] = useState(false);
  const openFolder = async (directory: string) => {
    if (loadingFolders) return;
    setLoadingFolders(true); setErr(null);
    try {
      const result = await api.browseProjects(directory);
      rememberProjects(result.projects);
      setBrowse(result); setQuery('');
    }
    catch (e) { setErr(errMsg(e)); } finally { setLoadingFolders(false); }
  };
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [model, setModel] = useState<string>('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [codexCollaborationMode, setCodexCollaborationMode] = useState<'default' | 'plan'>('default');
  const [codexModels, setCodexModels] = useState<CodexModelCatalog | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsAttempt, setModelsAttempt] = useState(0);
  const [claudePerm, setClaudePerm] = useState<PermissionChoice>('acceptEdits');
  const [codexPerm, setCodexPerm] = useState<PermissionChoice | null>(null);
  const [settingsLoad, setSettingsLoad] = useState<'loading' | 'ready' | 'error'>('loading');
  const [settingsError, setSettingsError] = useState('');
  const [settingsAttempt, setSettingsAttempt] = useState(0);
  const codexPermissionTouched = useRef(false);
  const [isolate, setIsolate] = useState(false);
  /** 同じ依頼を複数のモデルに投げて比べる（全部「別の作業場所」） */
  const [compare, setCompare] = useState(false);
  const [compareModels, setCompareModels] = useState<string[]>(['sonnet', 'haiku']);
  /** 明示選択はそのパスだけに適用。他の未知パスへtrueを持ち越さない。 */
  const [isolateTouchedPath, setIsolateTouchedPath] = useState<string | null>(null);
  const isolateTouched = isolateTouchedPath === projectKey(projectPath);
  const selectedProject = projectInfo[projectKey(projectPath)];
  const hasGit = selectedProject?.hasGit ?? true;
  const isolateForProject = isolate && hasGit && (selectedProject?.hasGit === true || isolateTouched);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const refreshAgents = useCallback(() => {
    void api.agents(true).then(setAgents).catch((e) => setErr(errMsg(e)));
    setModelsAttempt((n) => n + 1);
  }, []);
  const attach = useAttachments();

  // 同じプロジェクトで別のタスクが動いているなら、ぶつからないように既定で「別の作業場所」にする
  const busyInProject = Object.values(sessions).some(
    (s) => projectKey(s.project.path) === projectKey(projectPath) && s.origin !== 'external' && isAlive(s.status) && !s.workspace,
  );
  useEffect(() => {
    if (!isolateTouched) setIsolate(selectedProject?.hasGit === true && busyInProject);
  }, [busyInProject, isolateTouched, projectPath, selectedProject?.hasGit]);

  useEffect(() => {
    if (!open) return;
    api
      .projects()
      .then((p) => {
        setProjects(p);
        rememberProjects(p);
        setProjectPath((cur) => cur || p[0]?.path || '');
      })
      .catch((e) => setErr(errMsg(e)));
    api.agents().then(setAgents).catch(() => setAgents(null));
  }, [open, rememberProjects]);

  useEffect(() => {
    if (!open || agent !== 'codex') return;
    let active = true;
    setModelsLoading(true);
    setCodexModels(null);
    void api.codexModels(modelsAttempt > 0, projectPath).then((catalog) => {
      if (active) setCodexModels(catalog);
    }).catch((e) => {
      if (active) setCodexModels({ models: [], defaultModel: null, defaultModelId: null, configuredReasoningEffort: null, source: 'unavailable', error: errMsg(e) });
    }).finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [open, agent, projectPath, modelsAttempt]);

  useEffect(() => { setReasoningEffort(''); }, [model, agent, projectPath]);

  useEffect(() => {
    codexPermissionTouched.current = false;
    setCodexPerm(null);
    setSettingsLoad('loading');
    setSettingsError('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSettingsLoad('loading');
    setSettingsError('');
    void api.settings().then(({ settings }) => {
      if (!active) return;
      if (!CODEX_PERMISSION_CHOICES.some((p) => p.value === settings.codexPermissionMode)) {
        throw new Error('Codexの既定の権限を読み取れませんでした');
      }
      if (!codexPermissionTouched.current) setCodexPerm(settings.codexPermissionMode);
      setSettingsLoad('ready');
    }).catch((e) => {
      if (!active) return;
      setSettingsError(errMsg(e));
      setSettingsLoad('error');
    });
    return () => { active = false; };
  }, [open, settingsAttempt]);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const focusPrompt = () => promptRef.current?.focus();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // 日本語の変換中の Esc は変換の取り消しなので、窓は閉じない
      if (e.key === 'Escape') { if (!e.isComposing) onClose(); return; }
      // 文字を打てない所（プロジェクトのボタンの上など）で打ち始めたら、依頼の欄へ送る。
      // そのままだと日本語入力の文字が画面の左上に出るだけで、どこにも入らない
      const typing = e.key === 'Process' || (e.key.length === 1 && e.key !== ' ');
      if (!typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit'].includes(t.type)) return;
      promptRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (busy || permissionNotReady || effortUnsupported || !perm || (!prompt.trim() && !attach.items.length) || !projectPath || agentUnavailable || (comparing && compareModels.length < 2)) return;
    setBusy(true);
    setErr(null);
    try {
      const attachments = attach.uploads();
      if (comparing) {
        const list = await api.compare({ projectPath, prompt, permissionMode: perm, models: compareModels, attachments });
        if (list[0]) openTask(list[0].id);
      } else {
        const s = await api.create({ projectPath, prompt, agent, model: model || null,
          ...(agent === 'codex' ? { requestedReasoningEffort: reasoningEffort || null, codexCollaborationMode } : {}),
          permissionMode: perm, isolate: isolateForProject, attachments });
        openTask(s.id);
      }
      setPrompt('');
      attach.clear();
      setIsolateTouchedPath(null);
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const agentHint = AGENT_CHOICES.find((a) => a.value === agent)?.hint ?? '';
  const agentUnavailable = agents?.[agent]?.available === false ? agents[agent].reason : null;
  const perm = agent === 'codex' ? codexPerm : claudePerm;
  const permissionNotReady = agent === 'codex' && (settingsLoad !== 'ready' || !codexPerm || modelsLoading);
  const permissionChoices = agent === 'codex' ? CODEX_PERMISSION_CHOICES : PERMISSION_CHOICES;
  const permHint = permissionChoices.find((p) => p.value === perm)?.hint ?? '';
  // 「既定」が実際にどのモデルかをサーバーが教えてくれる。Codex は選べるモデルの一覧もサーバーから（手元の Codex が知っているもの）
  const agentInfo = agents?.[agent];
  const fixedChoices = MODEL_CHOICES.filter((m) => m.value);
  const defaultModel = agent === 'codex' ? codexModels?.defaultModel : agentInfo?.defaultModel;
  const modelChoices: { value: string | null; label: string }[] = [
    {
      value: null,
      label: defaultModel
        ? `既定（今は ${defaultModel}）`
        : agent === 'codex' ? '既定（Codex の設定）' : '既定（Claude Code の設定）',
    },
    ...(agent === 'codex' ? codexModels?.models ?? [] : fixedChoices),
  ];
  // A refresh never silently replaces a user's model choice with another model.
  if (model && !modelChoices.some((m) => m.value === model)) modelChoices.push({ value: model, label: `${model}（一覧で未確認）` });
  const selectedCodexModel = codexModels?.models.find((m) => m.value === (model || codexModels.defaultModelId));
  const effortChoices = selectedCodexModel?.supportedReasoningEfforts ?? [];
  const effortUnsupported = agent === 'codex' && !!reasoningEffort && !effortChoices.some((e) => e.reasoningEffort === reasoningEffort);
  const defaultEffort = codexModels?.configuredReasoningEffort ?? selectedCodexModel?.defaultReasoningEffort;
  // 一覧に無いパス（直接入力）は git かどうか分からないので、チェックは出してサーバー側で確かめる
  const comparing = agent === 'claude' && hasGit && compare;
  const toggleCompareModel = (v: string) =>
    setCompareModels((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-4xl rounded-2xl border border-zinc-700 bg-[#12151b] shadow-2xl flex flex-col md:flex-row overflow-hidden max-h-[92vh] md:max-h-[85vh]"
        role="dialog" aria-label="新しいタスク"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-full md:w-72 shrink-0 border-b md:border-b-0 md:border-r border-zinc-800 flex flex-col">
          <div className="p-3 text-xs text-zinc-300 space-y-2">
            <div className="font-semibold">プロジェクトを選択</div>
            <input aria-label="プロジェクトを検索" placeholder="名前・パスで検索" value={query} onChange={(e) => setQuery(e.target.value)} className="w-full rounded bg-black/30 border border-zinc-700 px-2 py-2" />
            {browse && <><div className="break-all text-zinc-400">{browse.path}</div><div className="flex flex-wrap gap-2"><button disabled={loadingFolders} onClick={() => { setBrowse(null); setQuery(''); }}>候補一覧へ</button>{browse.parent && <button disabled={loadingFolders} onClick={() => void openFolder(browse.parent!)}>↑ 親フォルダ</button>}<button className="text-sky-300" onClick={() => { setProjectPath(browse.path); focusPrompt(); }}>このフォルダを選択</button></div></>}
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5 max-h-32 md:max-h-none">
            {(browse?.projects ?? projects).filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase())).map((p) => (
              <div key={p.path} className="flex items-center gap-1"><button
                title={p.path} aria-pressed={projectPath === p.path}
                onClick={() => { setProjectPath(p.path); focusPrompt(); }}
                className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-2 ${projectPath === p.path ? 'bg-sky-600/30 text-sky-100' : 'hover:bg-zinc-800 text-zinc-300'}`}
              >
                <Icon name="folder" className="text-amber-300" />
                <span className="min-w-0"><span className="block truncate">{p.name}</span><span className="block truncate text-[10px] text-zinc-500">{p.path}</span></span>
              </button><button disabled={loadingFolders} onClick={() => void openFolder(p.path)} aria-label={`${p.name} のサブフォルダを開く`} className="p-2 rounded hover:bg-zinc-700 text-sky-300">›</button></div>
            ))}
            {(browse?.projects ?? projects).filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase())).length === 0 && (
              <div className="px-3 text-xs text-zinc-500">
                該当するフォルダがありません。パスを指定するか、設定でプロジェクトの親フォルダを追加できます。
              </div>
            )}
          </div>
          <div className="p-2 border-t border-zinc-800">
            <label htmlFor="project-path" className="block text-xs text-sky-300 mb-2">選択した作業フォルダ</label>
            <input
              id="project-path"
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder="フォルダのパスを直接指定"
              className="w-full text-xs mono bg-black/30 border border-zinc-700 rounded px-2 py-1.5 outline-none focus:border-zinc-500"
            />
            <button disabled={!projectPath || loadingFolders} onClick={() => void openFolder(projectPath)} className="text-xs text-sky-300 mt-2">{loadingFolders ? '読み込み中…' : 'このパスの中を参照'}</button>
          </div>
        </div>

        <div className="flex-1 p-4 flex flex-col gap-3 min-w-0 overflow-y-auto">
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
                    focusPrompt();
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

          {agent === 'codex' && <CodexAccount onChanged={refreshAgents} />}
          {agent === 'codex' && <label className="text-xs text-zinc-400">作業モード
            <select aria-label="Codexの作業モード" value={codexCollaborationMode} disabled={busy} onChange={e => setCodexCollaborationMode(e.target.value as 'default' | 'plan')} className="ml-2 bg-zinc-800 rounded px-2 py-1">
              <option value="default">通常</option><option value="plan">計画</option>
            </select>
            <span className="block mt-1">{codexCollaborationMode === 'plan' ? '実装を始める前に、調査・質問をして計画を立てます。' : '依頼に応じて調査・編集・検証を進めます。'}</span>
          </label>}
          <div {...attach.dropProps} className="flex-1 flex flex-col gap-2 min-h-0">
            <textarea
              ref={promptRef}
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={attach.onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey) && (prompt.trim() || attach.items.length) && projectPath) { e.preventDefault(); void submit(); }
              }}
              placeholder={
                '何をしてほしいか、話すように書いてください。\n例: ログイン画面で空欄のまま送信できてしまうのを直して。直したらテストも通して。\n\n画面の写真や資料は、貼り付け（Ctrl+V）かここへドラッグすると添えられます。'
              }
              className={`flex-1 min-h-[110px] md:min-h-[180px] text-sm bg-black/30 border rounded-md px-3 py-2 outline-none focus:border-zinc-500 resize-none leading-relaxed ${attach.dragging ? 'border-sky-500 bg-sky-500/10' : 'border-zinc-700'}`}
            />
            <AttachList state={attach} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="text-xs text-zinc-500 flex items-center gap-2">
              モデル
              <select
                value={model}
                disabled={busy || (agent === 'codex' && modelsLoading)}
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
            {agent === 'codex' && <label className="text-xs text-zinc-500 flex items-center gap-2">
              推論の深さ
              <select aria-label="推論の深さ" value={reasoningEffort}
                disabled={busy || modelsLoading || (!effortChoices.length && !reasoningEffort)}
                onChange={(e) => setReasoningEffort(e.target.value)}
                className="bg-black/30 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200">
                <option value="">{defaultEffort ? `既定（${defaultEffort}）` : '既定（Codex の設定）'}</option>
                {effortUnsupported && <option value={reasoningEffort} disabled>{reasoningEffort}（対応を確認できません）</option>}
                {effortChoices.map((effort) => <option key={effort.reasoningEffort} value={effort.reasoningEffort} title={effort.description}>{effort.reasoningEffort}</option>)}
              </select>
            </label>}
              <label className="text-xs text-zinc-500 flex items-center gap-2">
                許可
                <select
                  aria-label="許可"
                  value={perm ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const mode = e.target.value as PermissionChoice;
                    if (agent === 'codex') {
                      codexPermissionTouched.current = true;
                      setCodexPerm(mode);
                    } else setClaudePerm(mode);
                  }}
                  className="bg-black/30 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200"
                >
                  {perm === null && <option value="" disabled>既定の権限を読み込み中…</option>}
                  {permissionChoices.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            <span className="text-xs text-zinc-400">{permHint}</span>
          </div>
          {agent === 'codex' && modelsLoading && <p role="status" className="text-xs text-zinc-400">Codexのモデルと推論設定を確認しています…</p>}
          {effortUnsupported && !modelsLoading && <p role="alert" className="text-xs text-amber-300">選択した推論の深さは現在のモデルで確認できません。対応する設定か「既定」を選んでください。</p>}
          {agent === 'codex' && codexModels && codexModels.source !== 'live' && <p role="status" className="text-xs text-amber-300">
            {codexModels.source === 'cache' ? 'モデル一覧はローカルキャッシュです。現在利用できる設定は確認できていません。' : 'モデル一覧を取得できませんでした。既定の設定で起動できます。'}
            {codexModels.error && <span> {codexModels.error}</span>}
            <button type="button" className="underline ml-2" onClick={() => setModelsAttempt((n) => n + 1)}>再取得</button>
          </p>}
          {agent === 'codex' && settingsLoad === 'loading' && <p role="status" className="text-xs text-zinc-400">Codexの既定の権限を読み込んでいます。読み込み後に起動できます。</p>}
          {agent === 'codex' && settingsLoad === 'error' && <div role="alert" className="text-xs text-red-300">
            <p>Codexの既定の権限を読み込めませんでした: {settingsError}</p>
            <button type="button" className={`${btn.base} ${btn.ghost} mt-1`} onClick={() => setSettingsAttempt((n) => n + 1)}>権限設定を再読み込み</button>
          </div>}
          {hasGit && agent === 'claude' && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <label
                className="text-xs text-zinc-300 flex items-center gap-1.5 cursor-pointer select-none"
                title="同じ依頼を選んだモデルそれぞれに投げます。全部「別の作業場所」で動くので、見比べて気に入った案だけ取り込めます"
              >
                <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="accent-violet-500" />
                複数のモデルで比べる
              </label>
              {comparing && (
                <>
                  {MODEL_CHOICES.filter((m) => m.value).map((m) => {
                    const v = m.value as string;
                    const on = compareModels.includes(v);
                    return (
                      <button
                        key={v}
                        onClick={() => toggleCompareModel(v)}
                        className={`${btn.base} !py-0.5 !px-2 !text-xs ${on ? 'bg-violet-600 text-white' : btn.ghost}`}
                      >
                        {m.label.replace(/（.*）$/, '')}
                      </button>
                    );
                  })}
                  <span className="text-xs text-zinc-600">
                    {compareModels.length < 2 ? '2 つ以上選んでください' : `${compareModels.length} つの案が同時に動きます（使う量もその分増えます）`}
                  </span>
                </>
              )}
            </div>
          )}
          {hasGit && !comparing && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <label className="text-xs text-zinc-300 flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isolate}
                  onChange={(e) => {
                    setIsolate(e.target.checked);
                    setIsolateTouchedPath(projectKey(projectPath));
                  }}
                  className="accent-fuchsia-500"
                />
                別の作業場所で動かす
              </label>
              <span className="text-xs text-zinc-600">
                {busyInProject
                  ? 'このプロジェクトでは他のタスクが動いているので、ぶつからないようにコピーで作業するのがおすすめです。終わったら「取り込む」で反映します'
                  : '元のフォルダを触らず、コピー（git worktree）で作業します。終わったら「取り込む」で元のプロジェクトに反映します'}
              </span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <AttachButton state={attach} disabled={busy} />
            <span className="text-xs text-zinc-600">Ctrl+Enter で起動</span>
            <button
              disabled={busy || permissionNotReady || effortUnsupported || (!prompt.trim() && !attach.items.length) || !projectPath || !!agentUnavailable || (comparing && compareModels.length < 2)}
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
