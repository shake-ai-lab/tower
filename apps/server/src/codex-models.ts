import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { findCodexBin, CODEX_MISSING } from './codex-bin.ts';
import { RpcClient } from './agents/codex-rpc.ts';
import { codexAppServerLaunch, codexAppServerEnv } from './agents/codex-launch.ts';
import { codexHint, codexModelFallback, type ModelOption } from './model-defaults.ts';

export interface CodexModelCatalog {
  models: ModelOption[];
  defaultModel: string | null;
  defaultModelId: string | null;
  configuredReasoningEffort: string | null;
  source: 'live' | 'cache' | 'unavailable';
  error?: string;
}

export type CodexMetadataRequest = <T = unknown>(method: string, params?: unknown) => Promise<T>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

/** Read only protocol calls. Pagination and the runtime default are authoritative. */
export async function readCodexModelCatalog(request: CodexMetadataRequest, cwd?: string): Promise<CodexModelCatalog> {
  const raw: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = object(await request('model/list', { cursor, limit: 100, includeHidden: false }));
    if (!Array.isArray(page.data)) throw new Error('Codex のモデル一覧の形式が不正です');
    raw.push(...page.data.map(object));
    cursor = string(page.nextCursor);
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 100) throw new Error('Codex のモデル一覧のページ取得が完了しません');
      seen.add(cursor);
    }
  } while (cursor);
  const config = object(object(await request('config/read', { includeLayers: false, ...(cwd ? { cwd } : {}) })).config);
  const models: ModelOption[] = raw.filter((m) => !m.hidden && string(m.model)).map((m) => {
    const hint = codexHint(string(m.description) ?? '');
    const name = string(m.displayName) ?? String(m.model);
    const efforts = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map(object) : [];
    return {
      value: String(m.model), label: hint ? `${name}（${hint}）` : name,
      supportedReasoningEfforts: efforts.filter((r) => string(r.reasoningEffort)).map((r) => ({ reasoningEffort: String(r.reasoningEffort), description: string(r.description) ?? '' })),
      defaultReasoningEffort: string(m.defaultReasoningEffort), isDefault: m.isDefault === true,
    };
  });
  if (!models.length) throw new Error('Codex から選択可能なモデルが返りませんでした');
  const defaultModelId = string(config.model) ?? models.find((m) => m.isDefault)?.value ?? null;
  const selected = raw.find((m) => m.model === defaultModelId);
  return {
    models, defaultModelId, defaultModel: defaultModelId ? string(selected?.displayName) ?? defaultModelId : null,
    configuredReasoningEffort: string(config.model_reasoning_effort), source: 'live',
  };
}

/** Short-lived metadata connection: never starts a thread, turn, tool call or login. */
export async function withCodexMetadata<T>(read: (request: CodexMetadataRequest) => Promise<T>, cwd?: string, timeoutMs = 15_000): Promise<T> {
  const bin = findCodexBin();
  if (!bin) throw new Error(CODEX_MISSING);
  // Home by default avoids inadvertently selecting Tower's project configuration.
  const launch = codexAppServerLaunch(bin.command, bin.args);
  const child = spawn(launch.command, launch.args, {
    cwd: cwd || os.homedir(), env: codexAppServerEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const rpc = new RpcClient(child.stdout, child.stdin);
  child.stderr.resume(); // diagnostics may contain config details; do not return them to the UI
  child.on('error', (e) => rpc.close(e));
  child.on('exit', () => rpc.close(new Error('Codex の情報取得プロセスが終了しました')));
  const timer = setTimeout(() => rpc.close(new Error('Codex の情報取得がタイムアウトしました')), timeoutMs);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'tower-metadata', version: '1' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    return await read(rpc.request.bind(rpc));
  } finally {
    clearTimeout(timer);
    rpc.close(new Error('情報取得完了'));
    child.stdin.end();
    child.kill();
  }
}

const cache = new Map<string, { at: number; value: CodexModelCatalog }>();
const pending = new Map<string, Promise<CodexModelCatalog>>();
export function discoverCodexModels(refresh = false, cwd?: string): Promise<CodexModelCatalog> {
  const key = cwd ? path.resolve(cwd) : '';
  const previous = cache.get(key);
  if (!refresh && previous && Date.now() - previous.at < (previous.value.source === 'live' ? 60_000 : 5000)) return Promise.resolve(previous.value);
  const existing = pending.get(key);
  if (existing) return existing;
  const work = withCodexMetadata((request) => readCodexModelCatalog(request, cwd), cwd).catch((e): CodexModelCatalog => {
    const fallback = codexModelFallback();
    return { ...fallback, source: fallback.models.length ? 'cache' : 'unavailable', error: e instanceof Error ? e.message : String(e) };
  }).then((value) => {
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), value });
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
