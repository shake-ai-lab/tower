import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session, FormSchema } from '@tower/shared';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-form-upload-'));
process.env.TOWER_DATA_DIR = temporary;
const { saveFormAttachment } = await import('./form-attachments.ts');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const schema: FormSchema = { type: 'object', properties: {
  image: { type: 'openai/imagePicker', items: [], file: { accept: ['image/png'] } },
  folder: { type: 'string', format: 'uri', 'x-openai-input': { type: 'file', options: [], userOptions: { kind: 'directory' } } },
  locked: { type: 'string', format: 'uri', 'x-openai-input': { type: 'file', options: [{ uri: 'file:///known', name: 'known' }] } },
} };
const session = { id: 'upload-fixture', pending: { id: 'form', kind: 'form', schema } } as Session;
const body = { requestId: 'form', fieldPath: ['image'], attachment: { name: '日本語.png', mime: 'image/png', data: Buffer.from('fixture').toString('base64') } };

test('form upload validates pending and explicit upload field before saving', () => {
  assert.throws(() => saveFormAttachment(undefined, body), /タスク/);
  assert.throws(() => saveFormAttachment(session, { ...body, requestId: 'stale' }), /有効/);
  assert.throws(() => saveFormAttachment(session, { ...body, fieldPath: ['locked'] }), /追加できません/);
  assert.throws(() => saveFormAttachment(session, { ...body, fieldPath: ['__proto__'] }), /追加できません/);
  assert.throws(() => saveFormAttachment(session, { ...body, attachment: { ...body.attachment, mime: 'text/plain' } }), /ファイル形式/);
  assert.throws(() => saveFormAttachment(session, { ...body, attachment: { ...body.attachment, data: 'invalid***' } }), /形式/);
});

test('same-named uploads preserve bytes and use different private paths', () => {
  const first = saveFormAttachment(session, body), second = saveFormAttachment(session, body);
  assert.notEqual(first.uri, second.uri);
  assert.equal(first.name, '日本語.png');
  assert.equal(fs.readFileSync(fileURLToPath(first.uri), 'utf8'), 'fixture');
  const relative = path.relative(temporary, fileURLToPath(first.uri));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
});

test('long names cannot truncate upload identities and overwrite an earlier selection', () => {
  const originalNow = Date.now;
  Date.now = () => 1789278800000;
  try {
    const attachment = { ...body.attachment, name: `${'a'.repeat(200)}.png` };
    const first = saveFormAttachment(session, { ...body, attachment });
    const second = saveFormAttachment(session, { ...body, attachment: { ...attachment, data: Buffer.from('SECOND').toString('base64') } });
    assert.notEqual(first.uri, second.uri);
    assert.equal(fs.readFileSync(fileURLToPath(first.uri), 'utf8'), 'fixture');
    assert.equal(fs.readFileSync(fileURLToPath(second.uri), 'utf8'), 'SECOND');
  } finally { Date.now = originalNow; }
});

test('directory selection requires a directory field and an existing absolute folder', () => {
  const selected = saveFormAttachment(session, { requestId: 'form', fieldPath: ['folder'], directoryPath: temporary });
  assert.equal(fs.realpathSync(fileURLToPath(selected.uri)), fs.realpathSync(temporary));
  assert.throws(() => saveFormAttachment(session, { requestId: 'form', fieldPath: ['folder'], directoryPath: '.' }), /絶対パス/);
  assert.throws(() => saveFormAttachment(session, { ...body, directoryPath: temporary }), /ファイルを選択/);
  assert.throws(() => saveFormAttachment(session, { ...body, fieldPath: ['folder'] }), /フォルダー/);
});
