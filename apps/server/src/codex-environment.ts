import os from 'node:os';
import path from 'node:path';
import { RpcError } from './agents/codex-rpc.ts';
import { withCodexMetadata, type CodexMetadataRequest } from './codex-models.ts';

export type InventoryStatus = 'ready' | 'unsupported' | 'auth-required' | 'failed';
export interface Inventory<T> { status: InventoryStatus; items: T[]; issues: string[] }
export interface CodexSkillInfo { name: string; path: string; scope: string; enabled: boolean; pluginId: string | null }
export interface CodexMcpInfo { name: string; authStatus: string; runtimeStatus: string | null; tools: string[]; issue: string | null; pluginId: string | null }
export interface CodexPluginInfo { id: string; name: string; marketplace: string; installed: boolean; enabled: boolean; disabledReason: string | null }
export interface CodexEnvironment {
  cwd: string; checkedAt: number;
  skills: Inventory<CodexSkillInfo>; mcp: Inventory<CodexMcpInfo>; plugins: Inventory<CodexPluginInfo>;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('invalid metadata response');
  return value;
}

/** Never expose raw RPC errors: upstream diagnostics can contain credentials or environment values. */
export function inventoryFailure(error: unknown): { status: InventoryStatus; reason: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RpcError && error.code === -32601) return { status: 'unsupported', reason: 'このCodexはこの一覧APIに対応していません。' };
  if (/unauthorized|unauthenticated|not.?logged.?in|authentication|required.*auth|\b401\b/i.test(message)) return { status: 'auth-required', reason: '認証が必要なため確認できません。Codexの接続状態を確認してください。' };
  if (/timeout|タイムアウト/i.test(message)) return { status: 'failed', reason: '確認がタイムアウトしました。再取得してください。' };
  if (/見つかりません|ENOENT/.test(message)) return { status: 'failed', reason: 'Codexまたは必要なファイルが見つかりません。' };
  return { status: 'failed', reason: '一覧を読み込めませんでした。接続状態と設定を確認して再取得してください。' };
}
async function section<T>(read: () => Promise<{ items: T[]; issues?: string[] }>): Promise<Inventory<T>> {
  try { const result = await read(); return { status: 'ready', items: result.items, issues: result.issues ?? [] }; }
  catch (error) { const failure = inventoryFailure(error); return { status: failure.status, items: [], issues: [failure.reason] }; }
}

export async function readCodexEnvironment(request: CodexMetadataRequest, cwd: string, refresh = false): Promise<CodexEnvironment> {
  const [skills, mcp, plugins] = await Promise.all([
    section<CodexSkillInfo>(async () => {
      const result = object(await request('skills/list', { cwds: [cwd], forceReload: refresh }));
      const entries = array(result.data).map(object);
      const items = entries.flatMap((entry) => array(entry.skills).map(object).map((skill) => ({
        name: string(skill.name) ?? '名前不明', path: string(skill.path) ?? '', scope: string(skill.scope) ?? 'unknown',
        enabled: skill.enabled === true, pluginId: string(skill.pluginId),
      })));
      const errors = entries.flatMap((entry) => array(entry.errors));
      return { items, issues: errors.length ? [`${errors.length}件のスキル定義を読み込めませんでした。`] : [] };
    }),
    section<CodexMcpInfo>(async () => {
      const items: CodexMcpInfo[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page = object(await request('mcpServerStatus/list', { cursor, limit: 100, detail: 'toolsAndAuthOnly' }));
        items.push(...array(page.data).map(object).map((server) => ({
          name: string(server.name) ?? '名前不明', authStatus: string(server.authStatus) ?? 'unknown',
          runtimeStatus: string(server.runtimeStatus), tools: Object.keys(object(server.tools)),
          issue: server.toolsError ? inventoryFailure(new Error(String(server.toolsError))).reason : null,
          pluginId: string(server.pluginId),
        })));
        cursor = string(page.nextCursor);
        if (cursor) {
          if (seen.has(cursor) || seen.size >= 100) throw new Error('invalid repeated metadata cursor');
          seen.add(cursor);
        }
      } while (cursor);
      return { items };
    }),
    section<CodexPluginInfo>(async () => {
      const result = object(await request('plugin/list', { cwds: [cwd], forceRefetch: false, marketplaceKinds: ['local'] }));
      const marketplaces = array(result.marketplaces).map(object);
      const items = marketplaces.flatMap((marketplace) => array(marketplace.plugins).map(object).map((plugin) => ({
        id: string(plugin.id) ?? '', name: string(object(plugin.interface).displayName) ?? string(plugin.name) ?? '名前不明',
        marketplace: string(marketplace.name) ?? '', installed: plugin.installed === true, enabled: plugin.enabled === true,
        disabledReason: ['disabled_by_admin', 'plan_not_eligible', 'required_app_unavailable', 'unknown'].includes(String(plugin.disabledReason)) ? String(plugin.disabledReason) : null,
      })));
      const errors = Array.isArray(result.marketplaceLoadErrors) ? result.marketplaceLoadErrors : [];
      return { items, issues: errors.length ? [`${errors.length}件のローカルプラグイン一覧を読み込めませんでした。`] : [] };
    }),
  ]);
  return { cwd, checkedAt: Date.now(), skills, mcp, plugins };
}

const cache = new Map<string, CodexEnvironment>();
const pending = new Map<string, Promise<CodexEnvironment>>();
export function discoverCodexEnvironment(refresh = false, cwd?: string): Promise<CodexEnvironment> {
  const directory = path.resolve(cwd || os.homedir());
  const previous = cache.get(directory);
  if (!refresh && previous && Date.now() - previous.checkedAt < 30_000) return Promise.resolve(previous);
  const existing = pending.get(directory);
  if (existing) return existing;
  const work = withCodexMetadata((request) => readCodexEnvironment(request, directory, refresh), directory, 30_000).catch((error): CodexEnvironment => {
    const failure = inventoryFailure(error);
    const empty = () => ({ status: failure.status, items: [], issues: [failure.reason] });
    return { cwd: directory, checkedAt: Date.now(), skills: empty(), mcp: empty(), plugins: empty() };
  }).then((result) => {
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(directory, result); return result;
  }).finally(() => pending.delete(directory));
  pending.set(directory, work);
  return work;
}
