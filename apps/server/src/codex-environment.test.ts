import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexEnvironment, inventoryFailure } from './codex-environment.ts';
import { RpcError } from './agents/codex-rpc.ts';

test('environment uses public read-only inventories and returns only presentation metadata', async () => {
  const calls: { method: string; params: unknown }[] = [];
  const data = await readCodexEnvironment(async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === 'skills/list') return { data: [{ cwd: 'C:/project', errors: [], skills: [{ name: 'repo-skill', path: 'C:/project/SKILL.md', scope: 'repo', enabled: false, pluginId: null, description: 'PRIVATE_DESCRIPTION', dependencies: { tools: [{ url: 'SECRET_URL' }] } }] }] } as T;
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'example', authStatus: 'bearerToken', runtimeStatus: null, tools: { lookup: { name: 'lookup', inputSchema: { const: 'SECRET_SCHEMA' }, _meta: { token: 'SECRET_TOKEN' } } }, toolsError: null, resources: [{ uri: 'SECRET_RESOURCE' }] }], nextCursor: null } as T;
    if (method === 'plugin/list') return { marketplaces: [{ name: 'local', plugins: [{ id: 'my-plugin@local', name: 'my-plugin', installed: true, enabled: true, interface: { displayName: 'My Plugin' }, shareContext: { creatorAccountUserId: 'SECRET_ACCOUNT' }, source: { url: 'SECRET_ORIGIN' } }] }], marketplaceLoadErrors: [] } as T;
    throw new Error(`Unexpected API ${method}`);
  }, 'C:/project', true);
  assert.deepEqual(calls.map((c) => c.method).sort(), ['mcpServerStatus/list', 'plugin/list', 'skills/list']);
  assert.deepEqual(calls.find((c) => c.method === 'skills/list')?.params, { cwds: ['C:/project'], forceReload: true });
  assert.deepEqual(calls.find((c) => c.method === 'plugin/list')?.params, { cwds: ['C:/project'], forceRefetch: false, marketplaceKinds: ['local'] });
  assert.equal(data.skills.items[0].enabled, false);
  assert.equal(data.mcp.items[0].runtimeStatus, null, 'catalog existence must not imply a connected runtime');
  assert.deepEqual(data.mcp.items[0].tools, ['lookup']);
  assert.equal(data.plugins.items[0].name, 'My Plugin');
  assert.doesNotMatch(JSON.stringify(data), /SECRET_|PRIVATE_DESCRIPTION/);
});

test('an unsupported API and authentication failure remain distinct while other inventory succeeds', async () => {
  const data = await readCodexEnvironment(async <T>(method: string): Promise<T> => {
    if (method === 'skills/list') return { data: [{ skills: [], errors: [{ message: 'SECRET_SKILL_ERROR', path: 'private' }] }] } as T;
    if (method === 'plugin/list') throw new RpcError('unknown method with SECRET_ERROR', -32601);
    throw new RpcError('401 authentication required token=SECRET_TOKEN');
  }, 'C:/project');
  assert.equal(data.skills.status, 'ready');
  assert.match(data.skills.issues[0], /1件/);
  assert.equal(data.plugins.status, 'unsupported');
  assert.equal(data.mcp.status, 'auth-required');
  assert.doesNotMatch(JSON.stringify(data), /SECRET_/);
});

test('MCP pagination preserves auth/runtime failure and hides raw discovery diagnostics', async () => {
  const data = await readCodexEnvironment(async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === 'skills/list') return { data: [] } as T;
    if (method === 'plugin/list') return { marketplaces: [] } as T;
    return ((params as { cursor: string | null }).cursor
      ? { data: [{ name: 'failed', authStatus: 'unknown', runtimeStatus: 'failed', tools: {}, toolsError: 'startup failed ENV=SECRET' }], nextCursor: null }
      : { data: [{ name: 'login', authStatus: 'notLoggedIn', runtimeStatus: 'authenticationRequired', tools: {}, toolsError: '401 Bearer SECRET' }], nextCursor: 'page2' }) as T;
  }, 'C:/project');
  assert.equal(data.mcp.status, 'ready');
  assert.equal(data.mcp.items.length, 2);
  assert.equal(data.mcp.items[0].authStatus, 'notLoggedIn');
  assert.match(data.mcp.items[0].issue!, /認証/);
  assert.equal(data.mcp.items[1].runtimeStatus, 'failed');
  assert.doesNotMatch(JSON.stringify(data), /SECRET/);
});

test('malformed and repeated pages fail visibly instead of becoming an empty successful inventory', async () => {
  const data = await readCodexEnvironment(async <T>(method: string): Promise<T> => {
    if (method === 'skills/list') return {} as T;
    if (method === 'plugin/list') return { marketplaces: [] } as T;
    return { data: [], nextCursor: 'repeated' } as T;
  }, 'C:/project');
  assert.equal(data.skills.status, 'failed');
  assert.equal(data.mcp.status, 'failed');
  assert.equal(data.plugins.status, 'ready');
  assert.match(inventoryFailure(new Error('timeout SECRET')).reason, /タイムアウト/);
  assert.doesNotMatch(inventoryFailure(new Error('token=SECRET')).reason, /SECRET/);
});
