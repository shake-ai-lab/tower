import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexModelCatalog } from './codex-models.ts';
import { codexModelFallback } from './model-defaults.ts';

const model = (name: string, isDefault = false) => ({
  id: `internal-${name}`, model: name, displayName: name.toUpperCase(), hidden: false, isDefault,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Quick' }, { reasoningEffort: 'medium', description: 'Balanced' },
  ],
});

test('live model/list pages preserve model identifiers, default and supported efforts', async () => {
  const calls: { method: string; params: unknown }[] = [];
  const result = await readCodexModelCatalog(async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === 'config/read') return { config: { model_reasoning_effort: 'low' } } as T;
    return ((params as { cursor: string | null }).cursor
      ? { data: [model('everyday', true)], nextCursor: null }
      : { data: [model('expensive'), { ...model('hidden'), hidden: true }], nextCursor: 'next' }) as T;
  }, 'C:/project');
  assert.equal(result.source, 'live');
  assert.equal(result.defaultModelId, 'everyday');
  assert.equal(result.defaultModel, 'EVERYDAY');
  assert.equal(result.configuredReasoningEffort, 'low');
  assert.deepEqual(result.models.map((m) => m.value), ['expensive', 'everyday']);
  assert.deepEqual(result.models[1].supportedReasoningEfforts, model('everyday').supportedReasoningEfforts);
  assert.equal(result.models[1].defaultReasoningEffort, 'medium');
  assert.equal(result.models[1].isDefault, true);
  assert.deepEqual(calls.at(-1), { method: 'config/read', params: { includeLayers: false, cwd: 'C:/project' } });
});

test('effective config model overrides catalog default, including a custom model outside the list', async () => {
  const result = await readCodexModelCatalog(async <T>(method: string): Promise<T> => (
    method === 'config/read' ? { config: { model: 'custom-local', model_reasoning_effort: 'high' } }
      : { data: [model('catalog-default', true)], nextCursor: null }
  ) as T);
  assert.equal(result.defaultModelId, 'custom-local');
  assert.equal(result.defaultModel, 'custom-local');
});

test('does not infer a default from list order and rejects repeated pagination', async () => {
  const result = await readCodexModelCatalog(async <T>(method: string): Promise<T> => (
    method === 'config/read' ? { config: {} } : { data: [model('first')], nextCursor: null }
  ) as T);
  assert.equal(result.defaultModelId, null);
  await assert.rejects(readCodexModelCatalog(async <T>(): Promise<T> => ({ data: [model('one')], nextCursor: 'loop' }) as T), /ページ取得が完了しません/);
});

test('local fallback exposes cached efforts without guessing the configured default', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-model-cache-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({ models: [{
    slug: 'cached', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low', description: 'Quick' }],
  }] }));
  const result = codexModelFallback(dir);
  assert.equal(result.defaultModelId, null);
  assert.equal(result.defaultModel, null);
  assert.deepEqual(result.models[0].supportedReasoningEfforts, [{ reasoningEffort: 'low', description: 'Quick' }]);
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model="custom"\nmodel_reasoning_effort="high"');
  assert.equal(codexModelFallback(dir).defaultModelId, 'custom');
  assert.equal(codexModelFallback(dir).configuredReasoningEffort, 'high');
});
