import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PendingQuestion, PendingPermission, Session } from '@tower/shared';
import { QuestionCard, PermissionCard } from './src/components/PendingCards';

const pending: PendingQuestion = { id: 'question', kind: 'question', createdAt: 1, questions: [{ id: 'one', header: '一つ目', question: '同じ質問', isSecret: true, options: [], multiSelect: false }, { id: 'two', header: '二つ目', question: '同じ質問', options: [], multiSelect: false }] };
test('同文質問を別の入力欄にし、秘密の入力欄をpassword表示する', () => {
  const html = renderToStaticMarkup(createElement(QuestionCard, { session: { id: 'session', status: 'waiting_question' } as Session, pending }));
  assert.match(html, /type="password"/);
  assert.match(html, /type="text"/);
  assert.match(html, /非公開の回答/);
  assert.match(html, /停止・応答終了・接続切断で無効/);
});
test('非同期質問は作業継続中と停止後の回答方法を説明する', () => {
  const asynchronous = { ...pending, delivery: 'async' as const };
  const active = renderToStaticMarkup(createElement(QuestionCard, { session: { id: 'session', status: 'running' } as Session, pending: asynchronous }));
  assert.match(active, /ほかの作業を続けています/);
  const stopped = renderToStaticMarkup(createElement(QuestionCard, { session: { id: 'session', status: 'stopped' } as Session, pending: asynchronous }));
  assert.match(stopped, /同じ会話を再開して伝えます/);
  assert.match(stopped, /再開して回答を送る/);
});

test('URL手続きは安全なリンクと独立した完了確認を表示し、実行可能URLを開かない', () => {
  const permission: PendingPermission = { id: 'procedure', kind: 'permission', toolName: 'Mcp', input: { mode: 'url', url: 'https://example.test/procedure' }, headline: '手続き', detail: '', risk: 'mid', canAlwaysAllow: false, alwaysRules: [], createdAt: 1 };
  const render = (url: string) => renderToStaticMarkup(createElement(PermissionCard, { session: { id: 'session', project: { path: 'C:/fixture' } } as Session, pending: { ...permission, input: { ...permission.input, url } } }));
  const html = render('https://example.test/procedure');
  assert.match(html, /href="https:\/\/example.test\/procedure"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /手続きが完了しました/);
  for (const url of ['javascript:alert(1)', 'file:///private', 'https://user:password@example.test/']) assert.doesNotMatch(render(url), /手続きのページを開く/);
});
