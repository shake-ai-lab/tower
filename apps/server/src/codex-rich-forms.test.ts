import test from 'node:test';
import assert from 'node:assert/strict';
import { formUploadConfig, prepareFormValidator, type FormSchema } from '@tower/shared';

const image: FormSchema = { type: 'openai/imagePicker', items: [{ id: 'red', title: '赤', image: 'data:image/svg+xml;base64,PHN2Zy8+' }, { id: 'blue', title: '青', image: 'data:image/png;base64,YQ==' }] };
const file: FormSchema = { type: 'string', format: 'uri', 'x-openai-input': { type: 'file', options: [{ uri: 'file:///provided.png', name: 'provided.png' }] } };

test('legacy imagePicker returns exact selected ID and only permits custom file URI when declared', () => {
  const validate = prepareFormValidator(image);
  assert.equal(validate('red'), null);
  for (const value of ['赤', 'unknown', 'file:///custom.png', ['red'], { id: 'red' }]) assert.ok(validate(value));
  const custom = prepareFormValidator({ ...image as object, file: { accept: ['image/*'] } });
  assert.equal(custom('blue'), null);
  assert.equal(custom('file:///C:/uploads/custom.png'), null);
  assert.ok(custom('https://example.com/custom.png'));
  assert.ok(custom('file://untrusted-host/share.png'));
  const constrained = prepareFormValidator({ ...image as object, anyOf: [{ const: 'red' }] });
  assert.ok(constrained('blue'), 'other JSON Schema constraints remain enforced');
});

test('file picker enforces advertised choices, array rules, and explicit userOptions', () => {
  const validate = prepareFormValidator(file);
  assert.equal(validate('file:///provided.png'), null);
  assert.ok(validate('file:///not-provided.png'));
  const many: FormSchema = { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', format: 'uri' }, 'x-openai-input': { type: 'file', options: [{ uri: 'file:///provided.png', name: 'provided.png' }], userOptions: { kind: 'directory' } } };
  const validateMany = prepareFormValidator(many);
  assert.equal(validateMany(['file:///provided.png', 'file:///C:/selected']), null);
  assert.ok(validateMany([]));
  assert.ok(validateMany(['file:///provided.png', 'file:///provided.png']));
  assert.ok(validateMany(['https://example.com/injected']));
});

test('upload lookup resolves escaped object keys, local refs, arrays, variants and rejects ambiguous policies', () => {
  const root: FormSchema = { type: 'object', properties: { 'a/b': { type: 'array', items: { $ref: '#/$defs/choice' } } }, $defs: { choice: { ...image as object, file: { accept: ['image/png', '.jpg'] } } } };
  assert.deepEqual(formUploadConfig(root, ['a/b', '0']), { kind: 'file', accept: ['image/png', '.jpg'] });
  assert.equal(formUploadConfig(root, ['a/b', '-1']), null);
  assert.equal(formUploadConfig(root, ['missing']), null);
  assert.deepEqual(formUploadConfig({ oneOf: [root, { type: 'null' }], $defs: root.$defs }, ['a/b', '0']), { kind: 'file', accept: ['image/png', '.jpg'] });
  assert.equal(formUploadConfig({ oneOf: [{ ...image as object, file: { accept: ['.png'] } }, { ...image as object, file: { accept: ['.exe'] } }] }, []), null);
  assert.equal(formUploadConfig({ $ref: '#/$defs/self', $defs: { self: { $ref: '#/$defs/self' } } }, []), null);
});

test('malformed rich schemas fail generically and preview size does not expand answer limit', () => {
  for (const schema of [{ type: 'openai/imagePicker', items: [{ id: 'PRIVATE', title: 'private', image: 'x' }, { id: 'PRIVATE', title: 'duplicate', image: 'x' }] }, { ...file as object, 'x-openai-input': { type: 'file', options: [{}] } }]) {
    assert.throws(() => prepareFormValidator(schema), (error: Error) => !error.message.includes('PRIVATE'));
  }
  const large = prepareFormValidator({ type: 'openai/imagePicker', items: [{ id: 'a', title: 'A', image: `data:image/png;base64,${'Y'.repeat(130_000)}` }] });
  assert.equal(large('a'), null);
  assert.ok(prepareFormValidator(true)('a'.repeat(128_001)));
});
