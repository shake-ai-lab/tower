import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { PermissionChoice, Session } from '@tower/shared';
import { CodexRunner } from './agents/codex.ts';
import { autoAllow, codexPolicy } from './agents/codex-translate.ts';
import { validateSettings } from './config.ts';
import { Db } from './db.ts';
import { Hub } from './hub.ts';
import { SessionManager } from './manager.ts';
import type { AgentRunner } from './agents/types.ts';

test('Codex の既定権限は有効な値だけ保存する', () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
    assert.deepEqual(validateSettings({ codexPermissionMode: mode }), { codexPermissionMode: mode });
  }
  assert.deepEqual(validateSettings({}), {});
  for (const bad of ['', null, true, 'full-access', {}]) {
    assert.throws(() => validateSettings({ codexPermissionMode: bad as PermissionChoice }), /Codex/);
  }
});

test('既定権限は古い設定を補完し、保存とプロセス再起動後も維持する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-permission-config-'));
  const moduleUrl = new URL('./config.ts', import.meta.url).href;
  const run = (code: string) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      env: { ...process.env, TOWER_DATA_DIR: dir }, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ autoResume: false, port: 4800 }));
    assert.equal(run(`const c = await import(${JSON.stringify(moduleUrl)}); console.log(c.loadConfig().codexPermissionMode);`), 'acceptEdits');
    run(`const c = await import(${JSON.stringify(moduleUrl)}); c.saveConfig(c.validateSettings({codexPermissionMode: 'default'}));`);
    assert.equal(run(`const c = await import(${JSON.stringify(moduleUrl)}); console.log(c.loadConfig().codexPermissionMode);`), 'default');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.autoResume, false);
    assert.equal(saved.codexPermissionMode, 'default');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex のコマンド承認を読み取り風の名前・式で迂回しない', () => {
  for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
    for (const command of ['git diff --output=some-file.txt', 'rg --pre=node foo .', 'Get-ChildItem | Where-Object { [System.IO.File]::WriteAllText("x", "y") }', 'Get-Content a']) {
      assert.equal(autoAllow(mode, { kind: 'command', command }), null, `${mode}: ${command}`);
    }
  }
});

// 外部プロセスや利用者のデータを使わず、実 Runner の RPC 境界を検証する。
function fixture(mode: PermissionChoice) {
  const hub = new Hub(new Db(':memory:'));
  const session: Session = {
    id: 'permission-test', agent: 'codex', agentSessionId: 'thread',
    project: { path: process.cwd(), name: 'fixture' }, title: 'test', prompt: 'test',
    model: null, permissionMode: mode, status: 'running', activity: '', pending: null,
    report: null, turns: 0, costUsd: 0, toolCalls: 0, changedFiles: [],
    createdAt: 1, updatedAt: 1, lastError: null,
  };
  hub.add(session);
  const runner = new CodexRunner(session, hub);
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const internals = runner as unknown as {
    rpc: unknown; threadId: string; turnId: string | null;
    startTurn(input: unknown[]): Promise<void>;
    openThread(common: Record<string, unknown>, resume?: string): Promise<string>;
    onRequest(method: string, params: Record<string, unknown>, id: string): Promise<unknown>;
  };
  internals.threadId = 'thread';
  internals.rpc = {
    close: () => {},
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { turn: { id: `turn-${calls.length}` }, thread: { id: 'resumed' } };
    },
  };
  return { runner, internals, calls, hub };
}

test('MCP入力フォームは全権限・別名modeでも人の入力を待ち、辞退できる', async () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
    const { runner, internals, hub } = fixture(mode);
    const notices: string[] = [];
    hub.subscribe((event) => { if (event.type === 'timeline') notices.push(event.item.text); });
    for (const formMode of ['form', 'openai/form', 'openaiForm', undefined]) {
      const response = internals.onRequest('mcpServer/elicitation/request', {
        serverName: 'example_mcp', mode: formMode, message: '送信する内容を入力してください',
        requestedSchema: {
          type: 'object', required: ['name', 'count', 'approved', 'choice'],
          properties: { name: { type: 'string' }, count: { type: 'integer' }, approved: { type: 'boolean', default: true }, choice: { type: 'string', enum: ['first', 'second'] } },
        },
      }, `form-${formMode}`);
      assert.equal(hub.get(runner.id)!.pending?.kind, 'form');
      runner.answerForm({ requestId: hub.get(runner.id)!.pending!.id, action: 'decline' });
      assert.deepEqual(await response, { action: 'decline', content: null, _meta: null });
      assert.equal(hub.get(runner.id)!.pending, null);
    }
    assert.equal(notices.length, 8);
    assert.ok(notices.every((message) => message.includes('入力を待っています') || message.includes('辞退しました')));
  }
});

test('MCPのURL手続きは全自動でも完了の明示確認まで待つ', async () => {
  const { runner, internals, hub } = fixture('bypassPermissions');
  let answered = false;
  const response = internals.onRequest('mcpServer/elicitation/request', {
    serverName: 'example_mcp', mode: 'url', url: 'https://example.invalid/verification', message: 'ページで連携を完了してください',
  }, 'url-request').then((value) => { answered = true; return value; });
  await Promise.resolve();
  assert.equal(answered, false);
  const pending = hub.get(runner.id)!.pending;
  assert.equal(pending?.kind, 'permission');
  if (pending?.kind !== 'permission') assert.fail('明示確認が必要');
  assert.equal(pending.canAlwaysAllow, false);
  assert.match(pending.detail, /手続きが完了してから「手続きが完了しました」/);
  assert.match(pending.detail, /https:\/\/example.invalid\/verification/);
  runner.resolvePermission(pending.id, 'allow');
  assert.deepEqual(await response, { action: 'accept', content: null, _meta: null });
});

test('MCPのURL手続きは拒否・停止を完了として返さない', async () => {
  for (const action of ['deny', 'stop'] as const) {
    const { runner, internals, hub } = fixture('bypassPermissions');
    const response = internals.onRequest('mcpServer/elicitation/request', { serverName: 'example_mcp', mode: 'url', url: 'https://example.invalid' }, 'url-request');
    if (action === 'deny') runner.resolvePermission(hub.get(runner.id)!.pending!.id, 'deny');
    else await runner.stop();
    assert.deepEqual(await response, { action: action === 'deny' ? 'decline' : 'cancel', content: null, _meta: null });
  }
});

test('通常の質問は全自動でも利用者の回答を渡す', async () => {
  const { runner, internals, hub } = fixture('bypassPermissions');
  const response = internals.onRequest('item/tool/requestUserInput', {
    questions: [{ id: 'name', header: '名前', question: '表示名は？', options: null }],
  }, 'question');
  assert.equal(hub.get(runner.id)!.pending?.kind, 'question');
  runner.answerQuestion(hub.get(runner.id)!.pending!.id, { '表示名は？': '実際の回答' });
  assert.deepEqual(await response, { answers: { name: { answers: ['実際の回答'] } } });
});

test('実行中の権限変更は承認待ちを解除せず、steerを経ても次のturn/startまで適用しない', async () => {
  const { runner, internals, calls, hub } = fixture('default');
  await internals.startTurn([]);
  const pending = internals.onRequest('item/commandExecution/requestApproval', { itemId: 'command', command: 'npm test' }, 'request');
  const id = hub.get(runner.id)!.pending!.id;
  await runner.setPermissionMode('bypassPermissions');
  assert.equal(hub.get(runner.id)!.pending!.id, id);
  runner.resolvePermission(id, 'deny');
  assert.deepEqual(await pending, { decision: 'decline' });
  runner.send('追加の指示');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.at(-1)!.method, 'turn/steer');
  const file = internals.onRequest('item/fileChange/requestApproval', { itemId: 'file' }, 'file-request');
  assert.equal(hub.get(runner.id)!.pending?.kind, 'permission', '旧権限の編集確認を保つ');
  runner.resolvePermission(hub.get(runner.id)!.pending!.id, 'deny');
  await file;
  internals.turnId = null; // 現在の応答が終わった状態
  await internals.startTurn([]);
  assert.deepEqual(calls.at(-1)!.params.approvalPolicy, { granular: { sandbox_approval: false, rules: false, mcp_elicitations: true, request_permissions: false, skill_approval: false } });
  assert.deepEqual(calls.at(-1)!.params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.deepEqual(await internals.onRequest('item/commandExecution/requestApproval', { itemId: 'next', command: 'npm test' }, 'next-request'), { decision: 'accept' });
});

test('全自動から確認への変更と再開でも、選択した権限をCodexに渡す', async () => {
  const { runner, internals, calls, hub } = fixture('bypassPermissions');
  await internals.startTurn([]);
  await runner.setPermissionMode('default');
  internals.turnId = null;
  await internals.startTurn([]);
  assert.deepEqual(calls.at(-1)!.params.sandboxPolicy, codexPolicy('default').sandboxPolicy);
  assert.equal(calls.at(-1)!.params.approvalPolicy, 'untrusted');
  const pending = internals.onRequest('item/commandExecution/requestApproval', { itemId: 'command', command: 'Get-Content a' }, 'request');
  assert.equal(hub.get(runner.id)!.pending?.kind, 'permission');
  runner.resolvePermission(hub.get(runner.id)!.pending!.id, 'deny');
  await pending;
  const policy = codexPolicy(hub.get(runner.id)!.permissionMode);
  await internals.openThread({ approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox }, 'old-thread');
  assert.equal(calls.at(-1)!.method, 'thread/resume');
  assert.equal(calls.at(-1)!.params.sandbox, 'read-only');
});

test('SessionManager は実行中・停止中の Codex の権限を変更し、外部タスクは拒否する', async () => {
  const { runner, hub } = fixture('default');
  const manager = new SessionManager(hub);
  const internal = manager as unknown as { runners: Map<string, AgentRunner> };
  internal.runners.set(runner.id, runner);
  assert.equal((await manager.setPermissionMode(runner.id, 'auto')).permissionMode, 'auto');
  internal.runners.delete(runner.id);
  hub.update(runner.id, { status: 'stopped' });
  assert.equal((await manager.setPermissionMode(runner.id, 'acceptEdits')).permissionMode, 'acceptEdits');
  await assert.rejects(manager.setPermissionMode(runner.id, 'invalid' as PermissionChoice), /不正/);
  assert.equal(hub.get(runner.id)!.permissionMode, 'acceptEdits');
  hub.update(runner.id, { origin: 'external' });
  await assert.rejects(manager.setPermissionMode(runner.id, 'bypassPermissions'), /Tower/);
  assert.equal(hub.get(runner.id)!.permissionMode, 'acceptEdits');
});
