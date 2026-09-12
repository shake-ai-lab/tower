// Codex を本式のつなぎ方（app-server）で動かす部分: 受け渡しの形と、許可・質問・使った量の翻訳
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { RpcClient } from './agents/codex-rpc.ts';
import {
  UsageMeter,
  approvalDecision,
  codexPolicy,
  commandPending,
  elicitationResponse,
  fileChangePending,
  grantedPermissions,
  mcpActivity,
  permissionsPending,
  userInputAnswers,
  userInputPending,
  type UserInputQuestion,
} from './agents/codex-translate.ts';

const PS = '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command';
const tick = () => new Promise((r) => setImmediate(r));

test('app-server と 1 行 1 JSON で要求・応答・知らせ・問い合わせをやりとりする', async () => {
  const fromCodex = new PassThrough();
  const toCodex = new PassThrough();
  const rpc = new RpcClient(fromCodex, toCodex);
  const sent: Record<string, unknown>[] = [];
  toCodex.on('data', (d: Buffer) => {
    for (const l of d.toString().split('\n').filter(Boolean)) sent.push(JSON.parse(l) as Record<string, unknown>);
  });
  const notes: string[] = [];
  rpc.onNotification = (m) => notes.push(m);
  rpc.onRequest = async (m, p) => {
    if (m === 'item/tool/call') return { success: true, got: p };
    throw new Error('だめ');
  };

  const r = rpc.request<{ ok: number }>('initialize', { a: 1 });
  await tick();
  assert.deepEqual(sent[0], { id: 1, method: 'initialize', params: { a: 1 } });
  fromCodex.write('ログの行\n{"method":"turn/started","params":{}}\n{"id":1,"result":{"ok":1}}\n');
  assert.deepEqual(await r, { ok: 1 });
  assert.deepEqual(notes, ['turn/started'], 'JSON でない行は読み飛ばす');

  // Codex からの問い合わせには同じ id で答える。投げたらエラーで答える
  fromCodex.write('{"id":"s1","method":"item/tool/call","params":{"x":2}}\n{"id":7,"method":"other","params":{}}\n');
  await tick();
  await tick();
  assert.deepEqual(
    sent.find((m) => m.id === 's1'),
    { id: 's1', result: { success: true, got: { x: 2 } } },
  );
  assert.equal((sent.find((m) => m.id === 7)?.error as { message: string }).message, 'だめ');

  const bad = rpc.request('thread/start');
  await tick();
  fromCodex.write('{"id":2,"error":{"code":-32600,"message":"bad"}}\n');
  await assert.rejects(bad, /bad/);

  // つながりが切れたら、待っている要求は全部失敗にする
  const pending = rpc.request('turn/start');
  fromCodex.end();
  await assert.rejects(pending, /接続が切れました/);
  assert.equal(rpc.closed, true);
});

test('許可方針を Codex の「いつ聞くか」「どこまで触れるか」に写す', () => {
  const pick = (m: Parameters<typeof codexPolicy>[0]) => {
    const p = codexPolicy(m);
    return [p.approvalPolicy, p.sandbox];
  };
  assert.deepEqual(pick('default'), ['untrusted', 'read-only']);
  assert.deepEqual(pick('acceptEdits'), ['untrusted', 'workspace-write']);
  assert.deepEqual(pick('auto'), ['on-request', 'workspace-write']);
  assert.deepEqual(pick('bypassPermissions'), ['never', 'danger-full-access']);
  const ws = codexPolicy('acceptEdits').sandboxPolicy;
  assert.equal(ws.type === 'workspaceWrite' && ws.networkAccess, true, '作業フォルダの中で動かす時もネットは使える');
});

test('コマンドの許可: 包みを外した中身で見出しと危険度を作る', () => {
  const p = commandPending('a', { itemId: 'i', command: `${PS} 'npm test'`, cwd: 'C:\\w', reason: 'テストを確かめる' }, 1);
  assert.equal(p.headline, 'テストを実行したい（npm test）');
  assert.equal(p.risk, 'low');
  assert.match(p.detail, /^npm test/);
  assert.match(p.detail, /理由: テストを確かめる/);
  assert.equal(p.canAlwaysAllow, true);
  assert.equal(commandPending('b', { itemId: 'i', command: 'rm -rf dist' }).risk, 'high');

  const net = commandPending('c', {
    itemId: 'i',
    command: 'curl https://example.com',
    networkApprovalContext: { host: 'example.com', protocol: 'https' },
    availableDecisions: ['accept', 'decline'],
  });
  assert.equal(net.headline, 'ネットに接続したい: example.com');
  assert.equal(net.canAlwaysAllow, false, '「以後も許可」を出せない時は出さない');
  assert.deepEqual(net.alwaysRules, []);

  assert.equal(approvalDecision('allow'), 'accept');
  assert.equal(approvalDecision('allow_always'), 'acceptForSession');
  assert.equal(approvalDecision('deny'), 'decline');
});

test('ファイルの変更の許可: 先に届いた変更の中身から見出しを作る', () => {
  const add = fileChangePending('f', { itemId: 'i' }, [{ path: 'src/a.ts', kind: { type: 'add' }, diff: '+x' }]);
  assert.equal(add.headline, 'ファイルを作りたい: a.ts');
  assert.match(add.detail, /追加: src\/a\.ts\n\+x/);
  const many = fileChangePending('g', { itemId: 'i', reason: '整理' }, [
    { path: 'a.ts', kind: { type: 'update' }, diff: '' },
    { path: 'b.ts', kind: { type: 'delete' }, diff: '' },
    { path: 'c.ts', kind: { type: 'update' }, diff: '' },
    { path: 'd.ts', kind: { type: 'update' }, diff: '' },
  ]);
  assert.equal(many.headline, 'ファイルを変更・削除したい: a.ts, b.ts, c.ts ほか 1 件');
  const root = fileChangePending('h', { itemId: 'i', grantRoot: 'C:\\other' }, []);
  assert.equal(root.headline, 'フォルダに書き込みたい: C:\\other');
  assert.equal(root.risk, 'high', '作業フォルダの外に書くのは危ない');
});

test('追加の権限: 許可なら求められた分を渡し、以後も許可ならこのタスクの間ずっと', () => {
  const params = { reason: 'パッケージを入れる', permissions: { network: { enabled: true }, fileSystem: null } };
  assert.equal(permissionsPending('p', params).headline, '追加の権限がほしい: ネット接続');
  assert.deepEqual(grantedPermissions(params, 'allow'), { permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.equal(grantedPermissions(params, 'allow_always').scope, 'session');
  assert.deepEqual(grantedPermissions(params, 'deny'), { permissions: {}, scope: 'turn' });
});

test('質問: 画面の答え（質問文 → 答え）を Codex の形（質問の id → 答えの並び）にする', () => {
  const qs: UserInputQuestion[] = [
    { id: 'q1', header: '色', question: 'どの色にしますか？', options: [{ label: '青', description: '' }] },
    { id: 'q2', header: '名前', question: '名前は？', options: null },
  ];
  const pq = userInputPending('x', qs);
  assert.equal(pq.questions[1].options.length, 0, '選択肢の無い質問は自由に書いて答える');
  assert.deepEqual(userInputAnswers(qs, { 'どの色にしますか？': '青', '名前は？': 'タワー' }), {
    answers: { q1: { answers: ['青'] }, q2: { answers: ['タワー'] } },
  });
  assert.deepEqual(userInputAnswers(qs, {}).answers.q1, { answers: [] });
});

test('道具からの確認: 入力欄は決まった値で埋めて答える', () => {
  const form = {
    serverName: 'cua_repl',
    mode: 'form',
    message: '操作してよいですか',
    requestedSchema: { properties: { ok: { type: 'boolean' }, app: { type: 'string', enum: ['Excel', 'Word'] }, note: { type: 'string' } }, required: ['note'] },
  };
  assert.deepEqual(elicitationResponse(form, 'allow'), { action: 'accept', content: { ok: true, app: 'Excel', note: '' }, _meta: null });
  assert.deepEqual(elicitationResponse(form, 'deny'), { action: 'decline', content: null, _meta: null });
});

test('使った量: 再開した会話の最初は直近の 1 回分だけ足し、以後は累計の差分を足す', () => {
  const bd = (input: number, cached: number, output: number) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, outputTokens: output });
  const m = new UsageMeter({ input: 100, cacheRead: 10, output: 5 });
  let u = m.update(bd(5000, 4000, 100), bd(1000, 800, 50), 200_000);
  assert.deepEqual([u.input, u.cacheRead, u.output, u.context, u.contextWindow], [1100, 810, 55, 1000, 200_000]);
  u = m.update(bd(7000, 5500, 160), bd(2000, 1500, 60), 200_000);
  assert.deepEqual([u.input, u.cacheRead, u.output, u.context], [3100, 2310, 115, 2000]);
});

test('プラグインの道具の呼び出しを日本語の一言にする', () => {
  assert.equal(mcpActivity('cua_repl', 'js', { code: 'await cua.click()', title: '漫画スタジオの画面を開く' }), '画面操作: 漫画スタジオの画面を開く');
  assert.equal(mcpActivity('cua_repl', 'js', {}), '画面を操作しています');
  assert.equal(mcpActivity('github', 'search', {}), 'githubの search を使っています');
});
