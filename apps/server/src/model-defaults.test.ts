import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDefaultModel, claudeModelName, codexModels, configModel } from './model-defaults.ts';

const CACHE = {
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', description: 'Proven previous-generation model for coding and general work.', visibility: 'list', priority: 12 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', description: 'Automatic approval review model for Codex.', visibility: 'hide', priority: 43 },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Our most capable model for complex, demanding work.', visibility: 'list', priority: 1 },
    { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', description: 'Fast and affordable agentic coding model.', visibility: 'list', priority: 8 },
  ],
};

test('Codex: 隠しモデルを除いて Codex の並び順。既定は一覧の先頭', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-codex-home-'));
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(CACHE));
  const r = codexModels(home);
  assert.deepEqual(r.models, [
    { value: 'gpt-6-astra', label: 'GPT-6-Astra（最高性能・難しい仕事向け）' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna（速い・軽い）' },
    { value: 'gpt-5.5', label: 'GPT-5.5（一世代前）' },
  ]);
  assert.equal(r.defaultModel, 'GPT-6-Astra');
});

test('Codex: config.toml に model があればそれが既定', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-codex-home-'));
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(CACHE));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model_reasoning_effort = "high"\nmodel = "gpt-5.5"\n\n[desktop]\nmodel = "x"\n');
  assert.equal(codexModels(home).defaultModel, 'GPT-5.5');
});

test('Codex: 一覧が無ければ空（画面は固定の選択肢に戻る）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-codex-home-'));
  assert.deepEqual(codexModels(home), { models: [], defaultModel: null });
});

test('config.toml の model は最初の [表] より前だけを見る', () => {
  assert.equal(configModel('model = "gpt-5.5"'), 'gpt-5.5');
  assert.equal(configModel("model='a'\n[b]\nmodel='c'"), 'a');
  assert.equal(configModel('[desktop]\nmodel = "x"'), null);
  assert.equal(configModel('model_reasoning_effort = "high"'), null);
});

test('Claude: 設定の model を画面の名前に（無ければ null）', () => {
  assert.equal(claudeModelName('opus[1m]'), 'Opus 5');
  assert.equal(claudeModelName('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(claudeModelName('mystery-model'), 'mystery-model');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-claude-home-'));
  assert.equal(claudeDefaultModel(home, {}), null);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'haiku' }));
  assert.equal(claudeDefaultModel(home, {}), 'Haiku 4.5');
  assert.equal(claudeDefaultModel(home, { ANTHROPIC_MODEL: 'claude-fable-5-1' }), 'Fable 5.1', '環境変数が優先');
});
