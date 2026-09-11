import type {
  AgentAvailability,
  AgentKind,
  AnswerBody,
  BridgeStatus,
  ChangesResponse,
  CompareBody,
  CreateFeedbackBody,
  CreateSessionBody,
  FeedbackNote,
  FeedbackStatus,
  FileContent,
  MergeResult,
  MessageBody,
  PermissionDecisionBody,
  ProjectInfo,
  SaveFileBody,
  Session,
  TimelineItem,
} from '@tower/shared';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  projects: () => req<ProjectInfo[]>('/api/projects'),
  agents: () => req<Record<AgentKind, AgentAvailability>>('/api/agents'),
  sessions: () => req<Session[]>('/api/sessions'),
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
  stop: (id: string) => req<{ ok: boolean }>(`/api/sessions/${id}/stop`, { method: 'POST' }),
  merge: (id: string) => req<MergeResult>(`/api/sessions/${id}/merge`, { method: 'POST' }),
  file: (id: string, path: string) => req<FileContent>(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`),
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
