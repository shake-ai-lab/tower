import path from 'node:path';
import type { Session, TimelineKind } from '@tower/shared';

export interface ItemDisplay {
  kind: TimelineKind;
  text: string;
  detail?: string;
  imagePath?: string;
}

/** The completion notification describes the end of an operation, including failures. */
export function generatedImageDisplay(item: Record<string, unknown>, cwd: string): ItemDisplay {
  const status = typeof item.status === 'string' ? item.status : 'unknown';
  if (item.failure || status !== 'completed') {
    const failure = item.failure && typeof item.failure === 'object' ? item.failure as Record<string, unknown> : null;
    const detail = failure?.type === 'usageLimitExceeded'
      ? `画像生成の利用上限に達しました${typeof failure.resetsAt === 'number' ? `（再開予定: ${new Date(failure.resetsAt * 1000).toISOString()}）` : ''}`
      : `状態: ${status}${failure ? `\n${JSON.stringify(failure)}` : ''}`;
    return { kind: 'error', text: '画像を生成できませんでした', detail };
  }
  if (typeof item.savedPath !== 'string' || !item.savedPath.trim()) {
    return { kind: 'system', text: '画像生成は完了しましたが、表示できる保存先が届いていません', detail: 'Codexから保存先が返らなかったため、画像の表示を確認できません。' };
  }
  const file = path.resolve(cwd, item.savedPath);
  return { kind: 'tool_result', text: `画像を生成しました（${path.basename(file)}）`, detail: file, imagePath: file };
}

export const agentStatusLabel = (status: string): string => ({
  pendingInit: '起動中', running: '作業中', interrupted: '中断', completed: '完了',
  errored: '失敗', shutdown: '終了', notFound: '見つかりません',
}[status] ?? status);

type Agent = NonNullable<Session['subagents']>[number];

/** Only statuses supplied by Codex are merged; a completed tool call does not complete its child. */
export function mergeAgentStates(previous: Agent[] = [], item: Record<string, unknown>): Agent[] {
  const agents = new Map(previous.map(agent => [agent.id, { ...agent }]));
  const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string') : [];
  const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates as Record<string, unknown> : {};
  for (const id of new Set([...ids, ...Object.keys(states)])) {
    const raw = states[id];
    const state = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    agents.set(id, {
      ...agents.get(id), id,
      status: typeof state.status === 'string' ? state.status : agents.get(id)?.status ?? 'pendingInit',
      ...(typeof state.message === 'string' ? { message: state.message } : {}),
      ...(typeof item.model === 'string' ? { model: item.model } : {}),
      ...(typeof item.reasoningEffort === 'string' ? { reasoningEffort: item.reasoningEffort } : {}),
    });
  }
  return [...agents.values()];
}
