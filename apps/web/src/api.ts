import type {
  AgentAvailability,
  AgentKind,
  AnswerBody,
  FormAnswerBody,
  AttachmentUpload,
  BridgeStatus,
  ChangesResponse,
  CompareBody,
  CreateFeedbackBody,
  CreateSessionBody,
  FeedbackNote,
  FeedbackStatus,
  FileContent,
  FileListResponse,
  LineMarksResponse,
  MergeResult,
  MessageBody,
  PermissionDecisionBody,
  PermissionChoice,
  ProjectInfo,
  SaveFileBody,
  SearchResponse,
  Session,
  SettingsStatus,
  TimelineItem,
  TowerSettings,
  TreeResponse,
  UsageSummary,
} from '@tower/shared';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init }).catch(() => {
    throw new Error('Tower のサーバーにつながりません');
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `サーバーがエラーを返しました（${res.status}）`);
  return data;
}

/** 画面に出すエラー文（「Error: 」の英語の前置きを外す） */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface CodexModelCatalog {
  models: {
    value: string;
    label: string;
    supportedReasoningEfforts?: { reasoningEffort: string; description: string }[];
    defaultReasoningEffort?: string | null;
    isDefault?: boolean;
  }[];
  defaultModel: string | null;
  defaultModelId: string | null;
  configuredReasoningEffort: string | null;
  source: 'live' | 'cache' | 'unavailable';
  error?: string;
}

export interface CodexInventory<T> { status: 'ready' | 'unsupported' | 'auth-required' | 'failed'; items: T[]; issues: string[] }
export interface CodexEnvironment {
  cwd: string; checkedAt: number;
  skills: CodexInventory<{ name: string; path: string; scope: string; enabled: boolean; pluginId: string | null }>;
  mcp: CodexInventory<{ name: string; authStatus: string; runtimeStatus: string | null; tools: string[]; issue: string | null; pluginId: string | null }>;
  plugins: CodexInventory<{ id: string; name: string; marketplace: string; installed: boolean; enabled: boolean; disabledReason: string | null }>;
}

export const api = {
  projects: () => req<ProjectInfo[]>('/api/projects'),
  browseProjects: (path: string) => req<{ path: string; parent: string | null; projects: ProjectInfo[] }>(`/api/projects/browse?path=${encodeURIComponent(path)}`),
  agents: (refresh = false) => req<Record<AgentKind, AgentAvailability>>(`/api/agents${refresh ? '?refresh=1' : ''}`),
  codexModels: (refresh = false, cwd = '') => req<CodexModelCatalog>(`/api/codex/models?refresh=${refresh ? '1' : '0'}&cwd=${encodeURIComponent(cwd)}`),
  codexEnvironment: (refresh = false, cwd = '') => req<CodexEnvironment>(`/api/codex/environment?refresh=${refresh ? '1' : '0'}&cwd=${encodeURIComponent(cwd)}`),
  codexLogin: (start = false) => req<{ status: 'idle' | 'waiting' | 'success' | 'error'; url?: string; message?: string }>('/api/agents/codex/login', start ? { method: 'POST', body: '{}' } : undefined),
  sessions: () => req<Session[]>('/api/sessions'),
  /** 使った量のまとめ（サーバー側の台帳。タスクを消しても減らない） */
  usage: () => req<UsageSummary>('/api/usage'),
  timeline: (id: string) => req<TimelineItem[]>(`/api/sessions/${id}/timeline`),
  changes: (id: string) => req<ChangesResponse>(`/api/sessions/${id}/changes`),
  create: (body: CreateSessionBody) => req<Session>('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  compare: (body: CompareBody) => req<Session[]>('/api/sessions/compare', { method: 'POST', body: JSON.stringify(body) }),
  message: (id: string, body: MessageBody) =>
    req<{ ok: true }>(`/api/sessions/${id}/message`, { method: 'POST', body: JSON.stringify(body) }),
  permission: (id: string, body: PermissionDecisionBody) =>
    req<{ ok: true }>(`/api/sessions/${id}/permission`, { method: 'POST', body: JSON.stringify(body) }),
  answer: (id: string, body: AnswerBody) =>
    req<{ ok: true }>(`/api/sessions/${id}/answer`, { method: 'POST', body: JSON.stringify(body) }),
  answerForm: (id: string, body: FormAnswerBody) =>
    req<{ ok: true }>(`/api/sessions/${id}/form-answer`, { method: 'POST', body: JSON.stringify(body) }),
  uploadFormAttachment: (id: string, body: { requestId: string; fieldPath: string[]; attachment?: AttachmentUpload; directoryPath?: string }) =>
    req<{ uri: string; name: string }>(`/api/sessions/${id}/form-attachment`, { method: 'POST', body: JSON.stringify(body) }),
  stop: (id: string) => req<{ ok: boolean }>(`/api/sessions/${id}/stop`, { method: 'POST' }),
  /** 手で「完了」にする（動いていれば止める）。続きの指示を送ると再開する */
  complete: (id: string) => req<Session>(`/api/sessions/${id}/complete`, { method: 'POST' }),
  merge: (id: string) => req<MergeResult>(`/api/sessions/${id}/merge`, { method: 'POST' }),
  file: (id: string, path: string) => req<FileContent>(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`),
  tree: (id: string, path: string) => req<TreeResponse>(`/api/sessions/${id}/tree?path=${encodeURIComponent(path)}`),
  allFiles: (id: string) => req<FileListResponse>(`/api/sessions/${id}/files`),
  search: (id: string, q: string, caseSensitive = false) =>
    req<SearchResponse>(`/api/sessions/${id}/search?q=${encodeURIComponent(q)}${caseSensitive ? '&case=1' : ''}`),
  lineMarks: (id: string, path: string) => req<LineMarksResponse>(`/api/sessions/${id}/line-marks?path=${encodeURIComponent(path)}`),
  /** 画像をそのまま表示するための URL（<img src> 用） */
  rawUrl: (id: string, path: string) => `/api/sessions/${id}/raw?path=${encodeURIComponent(path)}`,
  /** 年表の項目でエージェントが読んだ画像（<img src> 用） */
  timelineImageUrl: (id: string, itemId: string) => `/api/sessions/${id}/timeline/${itemId}/image`,
  settings: () => req<SettingsStatus>('/api/settings'),
  setPermissionMode: (id: string, mode: PermissionChoice) => req<Session>(`/api/sessions/${id}/permission-mode`, { method: 'PUT', body: JSON.stringify({ mode }) }),
  setCodexCollaborationMode: (id: string, mode: 'default' | 'plan') => req<Session>(`/api/sessions/${id}/codex-collaboration-mode`, { method: 'PUT', body: JSON.stringify({ mode }) }),
  saveSettings: (body: Partial<TowerSettings>) => req<SettingsStatus>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  saveFile: (id: string, body: SaveFileBody) =>
    req<{ ok: true; path: string }>(`/api/sessions/${id}/file`, { method: 'PUT', body: JSON.stringify(body) }),
  config: () => req<{ externalKeepHours?: number; reformatReports?: boolean }>('/api/config'),
  bridge: () => req<BridgeStatus>('/api/bridge'),
  setBridge: (body: { enabled: boolean; permissions: boolean }) =>
    req<BridgeStatus>('/api/bridge', { method: 'POST', body: JSON.stringify(body) }),
  remove: (id: string) => req<{ ok: true }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  feedback: () => req<FeedbackStatus>('/api/feedback'),
  addFeedback: (body: CreateFeedbackBody) => req<FeedbackNote>('/api/feedback', { method: 'POST', body: JSON.stringify(body) }),
  removeFeedback: (id: string) => req<{ ok: true }>(`/api/feedback/${id}`, { method: 'DELETE' }),
};
