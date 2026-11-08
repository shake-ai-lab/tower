import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FormSchema, PendingForm, Session } from '@tower/shared';
import { FormCard, safeFormPreview } from './src/components/FormCard';

const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
function render(schema: FormSchema) {
  return renderToStaticMarkup(createElement(FormCard, { session: { id: 's', project: { path: 'C:/project', name: 'project' } } as Session, pending: { id: 'f', kind: 'form', serverName: 'fixture', message: 'choose', createdAt: 1, schema } as PendingForm }));
}
test('legacy images use img and explicit selection; upload appears only when requested', () => {
  const schema = { type: 'openai/imagePicker', items: [{ id: 'one', title: '第一画像', image: svg }] };
  const html = render(schema);
  assert.match(html, /第一画像/); assert.match(html, /<img/); assert.match(html, /type="radio"/);
  assert.ok(!html.includes('checked=""')); assert.ok(!html.includes('type="file"'));
  assert.ok(!html.includes('<svg')); assert.ok(!html.includes('<iframe'));
  assert.match(render({ ...schema, file: { accept: ['image/*', '.png'] } }), /accept="image\/\*,.png"/);
});
test('modern previews require explicit network loading and file/directory selection is visible', () => {
  const html = render({ type: 'string', oneOf: [{ const: 'a', title: 'Remote', 'x-openai-preview': { src: 'https://example.com/image.png' } }, { const: 'b', title: 'Embedded', 'x-openai-preview': { src: svg } }] });
  assert.match(html, /画像を読み込む（example.com）/); assert.ok(!html.includes('src="https://example.com'));
  const directory = render({ type: 'string', format: 'uri', 'x-openai-input': { type: 'file', options: [], userOptions: { kind: 'directory' } } });
  assert.match(directory, /フォルダーの場所/); assert.match(directory, /フォルダーを確認/); assert.ok(!directory.includes('type="file"'));
});
test('preview URLs reject executable, local, credential-bearing and arbitrary data sources', () => {
  for (const source of ['javascript:alert(1)', 'file:///C:/secret.png', 'data:text/html;base64,YQ==', 'https://secret@example.com/a', 'data:image/svg+xml,<svg/>']) assert.equal(safeFormPreview(source), null);
  assert.deepEqual(safeFormPreview(svg), { src: svg, remote: false });
});
test('secret image choices do not expose labels or image bytes', () => {
  const html = render({ type: 'openai/imagePicker', writeOnly: true, items: [{ id: 'PRIVATE_ID', title: 'PRIVATE_LABEL', image: svg }] });
  assert.ok(!html.includes('PRIVATE')); assert.ok(!html.includes(svg)); assert.match(html, /機密値/);
});
test('file picker masks choices and icons covered by variant or array-item secrets', () => {
  const input = { type: 'file', options: [{ uri: 'file:///PRIVATE_VALUE', name: 'PRIVATE_LABEL', icons: [{ src: svg }] }], userOptions: { kind: 'file' } };
  for (const schema of [
    { type: 'string', format: 'uri', oneOf: [{ const: 'file:///PRIVATE_VALUE', writeOnly: true }], 'x-openai-input': input },
    { type: 'array', items: { type: 'string', format: 'uri', writeOnly: true }, 'x-openai-input': input },
    { type: 'string', format: 'uri', anyOf: [{ const: 'file:///PRIVATE_VALUE', format: 'password' }], 'x-openai-input': input },
  ]) {
    const html = render(schema);
    assert.ok(!html.includes('PRIVATE_VALUE')); assert.ok(!html.includes('PRIVATE_LABEL')); assert.ok(!html.includes(svg)); assert.match(html, /機密値/);
  }
});
