import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PendingForm, Session } from '@tower/shared';
import { FormCard, reviewFormValue } from './src/components/FormCard';

test('MCPフォームは型付きフィールドと任意項目・確認・辞退・取消を表示し、値を勝手に選択しない', () => {
  const pending: PendingForm = { id: 'form', kind: 'form', serverName: 'fixture', message: '確認してください', createdAt: 1, schema: { type: 'object', required: ['name', 'number', 'flag', 'choice', 'secret', 'rows'], properties: {
    name: { type: 'string', title: '表示名' }, number: { type: 'number' }, flag: { type: 'boolean', default: true }, choice: { type: 'string', oneOf: [{ const: 'one', title: '第一候補' }, { const: 'two', title: '第二候補' }] }, secret: { type: 'string', format: 'password', default: 'hidden-default' }, optional: { type: 'string' }, rows: { type: 'array', items: { type: 'string' } },
  } } };
  const html = renderToStaticMarkup(createElement(FormCard, { session: { id: 'session' } as Session, pending }));
  for (const label of ['表示名', '第一候補', '第二候補', 'optional', '任意', '項目を追加', '入力内容を確認', '辞退', '取消']) assert.ok(html.includes(label), label);
  assert.match(html, /type="number"/);
  assert.match(html, /type="password"/);
  assert.ok(!html.includes('hidden-default'));
  assert.ok(!html.includes('value="true" selected'));
  assert.ok(!html.includes('<textarea'), '任意JSONだけに逃げない');
});

test('読めないフォーム定義も理由と辞退・取消を表示する', () => {
  const pending: PendingForm = { id: 'bad', kind: 'form', serverName: 'fixture', message: '入力', createdAt: 1, schema: { $ref: 'https://example.invalid/schema' } };
  const html = renderToStaticMarkup(createElement(FormCard, { session: { id: 'session' } as Session, pending }));
  assert.match(html, /入力フォームの定義を読み取れません/);
  assert.match(html, /辞退/);
  assert.match(html, /取消/);
});

test('確認画面は拡張objectの選択肢・参照・配列内でも秘密値を隠し、送信内容を変更しない', () => {
  const schema = { type: 'object', properties: {
    auth: { oneOf: [{ type: 'object', properties: { code: { type: 'string', writeOnly: true }, visible: { type: 'string' } } }] },
    rows: { type: 'array', items: { $ref: '#/$defs/row' } },
  }, $defs: { row: { type: 'object', properties: { credential: { type: 'string', format: 'password' } } } } };
  const value = { auth: { code: 'PRIVATE_ONE', visible: '公開値' }, rows: [{ credential: 'PRIVATE_TWO' }] };
  const preview = JSON.stringify(reviewFormValue(value, schema, schema));
  assert.ok(!preview.includes('PRIVATE_ONE'));
  assert.ok(!preview.includes('PRIVATE_TWO'));
  assert.ok(preview.includes('公開値'));
  assert.equal(value.auth.code, 'PRIVATE_ONE');
});

test('配列の選択schemaとdefault/const/enumでも入れ子の秘密値を画面へ出さない', () => {
  const array = { oneOf: [{ type: 'array', items: { type: 'string', writeOnly: true } }, { type: 'null' }] };
  assert.ok(!JSON.stringify(reviewFormValue(['PRIVATE_ARRAY_SENTINEL'], array, array)).includes('PRIVATE_ARRAY_SENTINEL'));
  for (const keyword of ['default', 'const', 'enum']) {
    const value = { credential: 'PRIVATE_DEFAULT_SENTINEL' };
    const schema = { type: 'object', properties: { credential: { type: 'string', writeOnly: true } }, [keyword]: keyword === 'enum' ? [value] : value };
    const pending = { id: 'private', kind: 'form', serverName: 'fixture', message: 'test', createdAt: 1, schema } as PendingForm;
    const html = renderToStaticMarkup(createElement(FormCard, { session: { id: 'session' } as Session, pending }));
    assert.ok(!html.includes('PRIVATE_DEFAULT_SENTINEL'), keyword);
  }
});
