import test from 'node:test';
import assert from 'node:assert/strict';
import type { FormSchema, Session, TimelineItem } from '@tower/shared';
import { prepareFormValidator } from '@tower/shared';
import { CodexRunner } from './agents/codex.ts';
import type { Hub } from './hub.ts';

function fixture() {
  let session: Session = {
    id: 'form-test', agent: 'codex', agentSessionId: 'thread', project: { path: process.cwd(), name: 'test' },
    title: 'test', prompt: 'test', model: null, permissionMode: 'bypassPermissions', status: 'running', activity: '',
    pending: null, report: null, turns: 0, costUsd: 0, toolCalls: 0, changedFiles: [], createdAt: 1, updatedAt: 1, lastError: null,
  };
  const timeline: TimelineItem[] = [];
  const updates: Partial<Session>[] = [];
  const hub = { get: () => session, update: (_id: string, patch: Partial<Session>) => { updates.push(patch); session = { ...session, ...patch }; return session; }, timeline: (item: TimelineItem) => timeline.push(item) } as unknown as Hub;
  const runner = new CodexRunner(session, hub);
  const internal = runner as unknown as { onRequest(method: string, params: Record<string, unknown>, id: string): Promise<unknown>; onNotification(method: string, params: Record<string, unknown>): void };
  const ask = (schema: FormSchema, request = 'request', mode = 'openai/form') => internal.onRequest('mcpServer/elicitation/request', { threadId: 'thread', turnId: null, serverName: 'fixture_mcp', message: '入力してください', mode, requestedSchema: schema, _meta: null }, request);
  return { runner, internal, ask, timeline, updates, session: () => session };
}

const schema: FormSchema = {
  type: 'object', required: ['name', 'count', 'enabled', 'list', 'nested'], additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 12 }, count: { type: 'number', minimum: 0, maximum: 5 }, enabled: { type: 'boolean' },
    optional: { type: 'string' }, list: { type: 'array', minItems: 1, uniqueItems: true, items: { anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] } },
    nested: { type: 'object', required: ['secret'], additionalProperties: { type: 'integer' }, properties: { secret: { type: 'string', writeOnly: true } } },
  },
};

test('modern openaiForm notification preserves nested content and does not auto-answer', async () => {
  const f = fixture();
  let answered = false;
  const response = f.ask({ type: 'object', required: ['nested'], properties: { nested: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } } } }, 'modern', 'openaiForm').then(result => { answered = true; return result; });
  await Promise.resolve();
  assert.equal(answered, false);
  assert.equal(f.session().pending?.kind, 'form');
  const content = { nested: { count: 0 } };
  f.runner.answerForm({ requestId: f.session().pending!.id, action: 'accept', content });
  assert.deepEqual(await response, { action: 'accept', content, _meta: null });
});

test('拡張MCPフォームの型・省略・空文字・false・0・配列・objectを保持し、入力値を履歴へ残さない', async () => {
  const f = fixture();
  let answered = false;
  const response = f.ask(schema).then((value) => { answered = true; return value; });
  await Promise.resolve();
  assert.equal(answered, false, 'fullaccessでも人の入力を待つ');
  const pending = f.session().pending;
  assert.equal(pending?.kind, 'form');
  if (pending?.kind !== 'form') assert.fail();
  assert.deepEqual(pending.schema, schema);
  const content = { name: '', count: 0, enabled: false, list: ['b', 'a'], nested: { secret: 'PRIVATE_VALUE_1592', extra: 7 } };
  assert.equal(f.runner.answerForm({ requestId: pending.id, action: 'accept', content }), true);
  assert.deepEqual(await response, { action: 'accept', content, _meta: null });
  assert.equal(f.session().pending, null);
  assert.ok(!JSON.stringify(f.timeline).includes('PRIVATE_VALUE_1592'));
  assert.ok(!JSON.stringify(f.updates).includes('PRIVATE_VALUE_1592'));
  assert.equal(f.runner.answerForm({ requestId: pending.id, action: 'accept', content }), false, '重複・期限切れ送信を受理しない');
});

test('制約違反の回答を拒否してpendingを維持し、有効な修正を待つ', async () => {
  const f = fixture();
  const response = f.ask(schema);
  const id = f.session().pending!.id;
  const valid = { name: 'ok', count: 1.5, enabled: false, list: ['a'], nested: { secret: 'private' } };
  for (const content of [{}, { ...valid, count: '1' }, { ...valid, count: 9 }, { ...valid, list: ['a', 'a'] }, { ...valid, name: 'too-long-private-value' }, { ...valid, injected: true }]) {
    assert.throws(() => f.runner.answerForm({ requestId: id, action: 'accept', content }), /入力内容/);
    assert.equal(f.session().pending?.id, id);
  }
  f.runner.answerForm({ requestId: id, action: 'accept', content: valid });
  assert.deepEqual(await response, { action: 'accept', content: valid, _meta: null });
});

test('複数フォームの順序を保ち、辞退・取消・停止を区別する', async () => {
  const f = fixture();
  const first = f.ask(schema, 'first');
  const id = f.session().pending!.id;
  const second = f.ask(schema, 'second');
  assert.equal(f.session().pending!.id, id);
  assert.equal(f.session().pendingCount, 2);
  f.runner.answerForm({ requestId: id, action: 'decline' });
  assert.deepEqual(await first, { action: 'decline', content: null, _meta: null });
  f.runner.answerForm({ requestId: f.session().pending!.id, action: 'cancel' });
  assert.deepEqual(await second, { action: 'cancel', content: null, _meta: null });
  const third = f.ask(schema, 'third');
  await f.runner.stop();
  assert.deepEqual(await third, { action: 'cancel', content: null, _meta: null });
  assert.equal(f.session().pending, null);
});

test('破損schema・外部参照は明示エラーとなり、通信せず取消できる', async () => {
  for (const bad of [{ type: 'not-a-type' }, { $ref: 'https://example.invalid/schema.json' }, { $async: true, type: 'object' }]) {
    const f = fixture();
    const response = f.ask(bad);
    const id = f.session().pending!.id;
    assert.throws(() => f.runner.answerForm({ requestId: id, action: 'accept', content: {} }), /入力フォームの定義/);
    assert.equal(f.session().pending?.id, id);
    f.runner.answerForm({ requestId: id, action: 'cancel' });
    assert.deepEqual(await response, { action: 'cancel', content: null, _meta: null });
  }
});

test('標準schemaのformat/enum/数値制約と拡張schemaのローカルref/oneOfを検証する', () => {
  const validate = prepareFormValidator({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['data', 'email'], properties: { email: { type: 'string', format: 'email' }, data: { $ref: '#/$defs/choice' } }, $defs: { choice: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['ok'] }] } } });
  assert.equal(validate({ email: 'a@example.invalid', data: 'ok' }), null);
  assert.equal(validate({ email: 'a@example.invalid', data: 2 }), null);
  assert.ok(validate({ email: 'private-invalid-email', data: 2 }));
  assert.ok(!validate({ email: 'private-invalid-email', data: 2 })!.includes('private-invalid-email'));
  assert.ok(validate({ email: 'a@example.invalid', data: 1.5 }));
  assert.ok(prepareFormValidator(true)(undefined));
});
