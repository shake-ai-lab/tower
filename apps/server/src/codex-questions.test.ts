import test from 'node:test';
import assert from 'node:assert/strict';
import type { PendingQuestion, Session, TimelineItem } from '@tower/shared';
import { CodexRunner } from './agents/codex.ts';
import { RpcError } from './agents/codex-rpc.ts';
import { asyncQuestionPending } from './agents/codex-translate.ts';
import type { AgentRunner } from './agents/types.ts';
import { Hub, interruptForRestart } from './hub.ts';
import { Db } from './db.ts';
import { SessionManager } from './manager.ts';
import { setReformatEnabled } from './reformat.ts';

setReformatEnabled(false);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sessionFixture = (): Session => ({ id: 'questions', agent: 'codex', agentSessionId: 'original-thread', project: { name: 'fixture', path: process.cwd() }, title: 'test', prompt: 'test', model: null, permissionMode: 'bypassPermissions', status: 'running', activity: '', pending: null, report: null, turns: 0, costUsd: 0, toolCalls: 0, changedFiles: [], createdAt: 1, updatedAt: 1, lastError: null });

function fixture() {
  let session = sessionFixture();
  const timeline: TimelineItem[] = [];
  const updates: Partial<Session>[] = [];
  const hub = { get: () => session, update: (_id: string, patch: Partial<Session>) => { updates.push(patch); session = { ...session, ...patch }; return session; }, timeline: (item: TimelineItem) => timeline.push(item) } as unknown as Hub;
  const runner = new CodexRunner(session, hub);
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const internal = runner as unknown as { threadId: string; turnId: string | null; rpc: unknown; onRequest(method: string, p: Record<string, unknown>, id: string): Promise<unknown>; onNotification(method: string, p: Record<string, unknown>): void; fail(e: Error): void };
  internal.threadId = 'original-thread'; internal.turnId = 'turn-one';
  internal.rpc = { request: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return { turn: { id: 'turn-two' } }; }, close: () => {} };
  const notify = (method: string, p: Record<string, unknown>) => internal.onNotification(method, { threadId: 'original-thread', turnId: 'turn-one', ...p });
  const asyncMessage = () => notify('item/completed', { item: { id: 'message', type: 'agentMessage', delivery: 'async', text: '回答を待ちながら進めます', questions: [{ title: '同じ質問', options: ['甲', '乙'] }, { title: '同じ質問', options: null }] } });
  const syncQuestion = () => internal.onRequest('item/tool/requestUserInput', { questions: [{ id: 'one', header: '同じ', question: '同じ質問', options: null, isSecret: true }, { id: 'two', header: '同じ', question: '同じ質問', options: null }] }, 'rpc-question');
  return { runner, internal, calls, notify, asyncMessage, syncQuestion, timeline, updates, session: () => session };
}

test('同文の同期2問をIDで区別し、秘密回答をRPCだけへ渡して経過には伏せる', async () => {
  const f = fixture();
  const response = f.syncQuestion();
  const pending = f.session().pending as PendingQuestion;
  assert.deepEqual(pending.questions.map((q) => q.id), ['one', 'two']);
  assert.equal(pending.questions[0].isSecret, true);
  assert.throws(() => f.runner.answerQuestion(pending.id, { '同じ質問': '共通値' }), /すべての質問/);
  assert.equal(f.session().pending?.id, pending.id);
  f.runner.answerQuestion(pending.id, { one: 'PRIVATE_ANSWER_4829', two: '公開の回答' });
  assert.deepEqual(await response, { answers: { one: { answers: ['PRIVATE_ANSWER_4829'] }, two: { answers: ['公開の回答'] } } });
  assert.ok(!JSON.stringify(f.timeline).includes('PRIVATE_ANSWER_4829'));
  assert.ok(!JSON.stringify(f.updates).includes('PRIVATE_ANSWER_4829'));
  assert.ok(f.timeline.some((item) => item.text.includes('非公開の回答') && item.text.includes('公開の回答')));
});

test('IDと旧質問文が衝突する回答を拒否し、秘密値を公開質問の履歴へ流さない', async () => {
  const f = fixture();
  const response = f.internal.onRequest('item/tool/requestUserInput', { questions: [
    { id: 'private_value', question: 'password', header: 'Private', isSecret: true, options: null },
    { id: 'password', question: 'Public label', header: 'Public', options: null },
  ] }, 'collision');
  const pending = f.session().pending!;
  assert.throws(() => f.runner.answerQuestion(pending.id, { password: 'PRIVATE_SENTINEL', 'Public label': 'public-answer' }), /すべての質問/);
  assert.equal(f.session().pending?.id, pending.id);
  assert.ok(!JSON.stringify(f.timeline).includes('PRIVATE_SENTINEL'));
  assert.equal(f.runner.answerQuestion(pending.id, { private_value: 'PRIVATE_SENTINEL', password: 'public-answer' }), true);
  assert.deepEqual(await response, { answers: { private_value: { answers: ['PRIVATE_SENTINEL'] }, password: { answers: ['public-answer'] } } });
  assert.ok(!JSON.stringify(f.timeline).includes('PRIVATE_SENTINEL'));
});

test('非同期質問中も作業を続け、回答を現在のturn/steerへ一度だけ送る', async () => {
  const f = fixture();
  f.asyncMessage();
  const pending = f.session().pending as PendingQuestion;
  assert.equal(pending.delivery, 'async');
  assert.equal(f.session().status, 'running');
  assert.equal(f.calls.length, 0, '質問表示だけではモデルを中断しない');
  f.notify('item/started', { item: { id: 'command', type: 'commandExecution', command: 'npm test' } });
  assert.equal(f.session().toolCalls, 1);
  f.runner.answerQuestion(pending.id, { 'message:0': '甲', 'message:1': '別の回答' });
  assert.equal(f.runner.answerQuestion(pending.id, { 'message:0': '乙', 'message:1': '二重回答' }), false);
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'turn/steer');
  assert.equal(f.calls[0].params.expectedTurnId, 'turn-one');
  const text = (f.calls[0].params.input as { text: string }[])[0].text;
  assert.match(text, /"id":"message:0","question":"同じ質問","answer":"甲"/);
  assert.match(text, /"id":"message:1","question":"同じ質問","answer":"別の回答"/);
  assert.equal(f.session().pending, null);
  assert.deepEqual(f.session().resolvedAsyncQuestionIds, [pending.id]);
  f.asyncMessage();
  assert.equal(f.session().pending, null, '遅れた項目通知で質問を復活させない');
});

test('応答が終わっても非同期質問を保持し、回答から同threadの次のturn/startを始める', async () => {
  const f = fixture();
  f.asyncMessage();
  const pending = f.session().pending!;
  f.notify('turn/completed', { turn: { id: 'turn-one', status: 'completed' } });
  assert.equal(f.session().pending?.id, pending.id);
  assert.equal(f.session().status, 'waiting_question');
  f.runner.answerQuestion(pending.id, { 'message:0': '甲', 'message:1': '回答' });
  await tick();
  assert.equal(f.calls[0].method, 'turn/start');
  assert.equal(f.calls[0].params.threadId, 'original-thread');
  assert.equal(f.session().pending, null);
  assert.equal(f.session().status, 'running');
});

test('送信受理前の停止・遅延応答で非同期質問を消さない', async () => {
  const f = fixture();
  let acknowledge!: (value: unknown) => void;
  f.internal.rpc = { request: (method: string) => method === 'turn/steer' ? new Promise((resolve) => { acknowledge = resolve; }) : Promise.resolve({}), close: () => {} };
  f.asyncMessage();
  const pending = f.session().pending!;
  f.runner.answerQuestion(pending.id, { 'message:0': '甲', 'message:1': '回答' });
  assert.equal(f.session().pending?.id, pending.id);
  await f.runner.stop();
  acknowledge({});
  await tick();
  assert.equal(f.session().status, 'stopped');
  assert.equal(f.session().pending?.id, pending.id);
  assert.equal(f.session().resolvedAsyncQuestionIds?.includes(pending.id) ?? false, false);
});

test('一般的なsteer拒否では質問と入力を残し、失敗を表示して再回答できる', async () => {
  const f = fixture();
  let attempts = 0;
  f.internal.rpc = { request: async () => { if (++attempts === 1) throw new RpcError('generic rejection'); return {}; } };
  f.asyncMessage();
  const pending = f.session().pending!;
  const answers = { 'message:0': '甲', 'message:1': '回答' };
  assert.equal(f.runner.answerQuestion(pending.id, answers), true);
  await tick();
  assert.equal(f.session().status, 'running');
  assert.match((f.session().pending as PendingQuestion).answerError!, /送信に失敗/);
  assert.equal((f.internal as unknown as { queued: unknown[] }).queued.length, 0);
  assert.equal(f.runner.answerQuestion(pending.id, answers), true);
  await tick();
  assert.equal(attempts, 2);
  assert.equal(f.session().pending, null);
});

test('実際のturn mismatchだけは手番完了後の次turnへ繰り越す', async () => {
  const f = fixture();
  const methods: string[] = [];
  f.internal.rpc = { request: async (method: string) => { methods.push(method); if (method === 'turn/steer') throw new RpcError('expected turn does not match active turn'); return { turn: { id: 'next' } }; } };
  f.asyncMessage();
  const pending = f.session().pending!;
  f.runner.answerQuestion(pending.id, { 'message:0': '甲', 'message:1': '回答' });
  await tick();
  assert.equal((f.internal as unknown as { queued: unknown[] }).queued.length, 1);
  f.notify('turn/completed', { turn: { id: 'turn-one', status: 'completed' } });
  await tick();
  assert.deepEqual(methods, ['turn/steer', 'turn/start']);
  assert.equal(f.session().pending, null);
});

test('未選択の通常設定は維持し、計画と明示的な通常切替だけ次turnへモデル・effort込みで送る', async () => {
  for (const mode of [undefined, 'plan', 'default'] as const) {
    const f = fixture();
    const s = f.session();
    s.codexCollaborationMode = mode; s.effectiveModel = 'actual-model'; s.reasoningEffort = 'high';
    f.internal.turnId = null;
    f.runner.send('次の作業');
    await tick();
    const params = f.calls[0].params;
    assert.equal(f.calls[0].method, 'turn/start');
    assert.deepEqual(params.collaborationMode, mode ? { mode, settings: { model: 'actual-model', reasoning_effort: 'high', developer_instructions: null } } : undefined);
  }
});

test('実行中の作業モード変更はsteerに載せず、次turnで現在の設定を読む', async () => {
  const f = fixture();
  f.session().codexCollaborationMode = 'plan'; f.session().effectiveModel = 'actual-model';
  f.runner.send('追加');
  await tick();
  assert.equal(f.calls[0].method, 'turn/steer');
  assert.equal(f.calls[0].params.collaborationMode, undefined);
  f.notify('turn/completed', { turn: { id: 'turn-one', status: 'completed' } });
  f.session().codexCollaborationMode = 'default';
  f.runner.send('通常に戻す');
  await tick();
  assert.equal((f.calls[1].params.collaborationMode as { mode: string }).mode, 'default');
});

test('turn/startの返事より先に応答完了が来ても回答受理後にrunningへ戻さない', async () => {
  const f = fixture();
  f.asyncMessage();
  f.notify('turn/completed', { turn: { id: 'turn-one', status: 'completed' } });
  let acknowledge!: (value: unknown) => void;
  f.internal.rpc = { request: () => new Promise((resolve) => { acknowledge = resolve; }), close: () => {} };
  f.runner.answerQuestion(f.session().pending!.id, { 'message:0': '甲', 'message:1': '回答' });
  f.internal.onNotification('turn/started', { threadId: 'original-thread', turn: { id: 'turn-two' } });
  f.internal.onNotification('turn/completed', { threadId: 'original-thread', turn: { id: 'turn-two', status: 'completed' } });
  acknowledge({ turn: { id: 'turn-two' } });
  await tick();
  assert.equal(f.session().pending, null);
  assert.equal(f.session().status, 'idle');
});

test('接続切断で同期質問だけを無効化し、非同期質問は残して説明する', async () => {
  const f = fixture();
  f.asyncMessage();
  const asynchronous = f.session().pending!.id;
  const response = f.syncQuestion();
  const synchronous = f.session().pending!.id;
  f.internal.fail(new Error('接続が切れました'));
  assert.deepEqual(await response, { answers: { one: { answers: [] }, two: { answers: [] } } });
  assert.equal(f.session().pending?.id, asynchronous);
  assert.equal(f.runner.answerQuestion(synchronous, { one: 'secret', two: 'value' }), false);
  assert.equal(f.runner.answerQuestion(asynchronous, { 'message:0': '甲', 'message:1': '回答' }), false, '終了済みrunnerへ回答しない');
  assert.ok(f.timeline.some((item) => item.text.includes('同期の質問は無効')));
  await assert.rejects(f.syncQuestion(), /接続終了/);
});

test('serverRequest/resolvedで取り下げた同期質問へ回答しない', async () => {
  const f = fixture();
  const response = f.syncQuestion();
  const id = f.session().pending!.id;
  f.notify('serverRequest/resolved', { requestId: 'rpc-question' });
  await response;
  assert.equal(f.runner.answerQuestion(id, { one: 'secret', two: 'value' }), false);
  assert.equal(f.session().pending, null);
});

test('再起動後の非同期回答は同じ会話をresumeし、秘密の履歴文と生の送信文を分離する', () => {
  const db = new Db(':memory:');
  const hub = new Hub(db);
  const question = asyncQuestionPending('saved-message', [{ title: '値は？', options: null }]);
  question.questions[0].isSecret = true;
  const original = { ...sessionFixture(), pending: question, asyncQuestions: [question] };
  const interrupted = interruptForRestart(original, 2)!;
  assert.equal(interrupted.pending?.id, question.id);
  hub.add(interrupted);
  const manager = new SessionManager(hub);
  const pendingSnapshots: (string | undefined)[] = [];
  hub.subscribe(event => { if (event.type === 'session') pendingSnapshots.push(event.session.pending?.id); });
  const calls: unknown[][] = [];
  const stub = { id: interrupted.id, start: (...args: unknown[]) => calls.push(args) } as unknown as AgentRunner;
  (manager as unknown as { makeRunner(s: Session): AgentRunner }).makeRunner = () => stub;
  assert.equal(manager.answerQuestion(interrupted.id, 'old-sync-id', { x: 'value' }), false);
  assert.equal(manager.answerQuestion(interrupted.id, question.id, { 'saved-message:0': 'PRIVATE_RESTART_249' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'original-thread');
  assert.match(String(calls[0][0]), /PRIVATE_RESTART_249/);
  assert.ok(!String(calls[0][3]).includes('PRIVATE_RESTART_249'));
  assert.equal(calls[0][4], question.id);
  assert.equal(hub.get(interrupted.id)?.asyncQuestions?.[0].id, question.id, 'RPC受理まで保持する');
  assert.ok(pendingSnapshots.length > 0 && pendingSnapshots.every(id => id === question.id), '再開途中も質問カードをunmountしない');
});
