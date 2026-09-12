// 「既定」を選んだ時に実際どのモデルで動くかと、Codex で選べるモデルの一覧。
// 画面のモデル欄に「既定（今は GPT-6-Astra）」のように出して、何で動くのか分かるようにする。
// - Codex: 選べるモデルは Codex 自身が取ってきて置いている ~/.codex/models_cache.json（VS Code の Codex 拡張と共通）。
//   既定は ~/.codex/config.toml の model、無ければ一覧のいちばん上（priority が最小。Codex 本体もそれを使う）
// - Claude: 環境変数 ANTHROPIC_MODEL、無ければ ~/.claude/settings.json の model（Tower の Claude はこの設定を読む）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_CHOICES, modelLabel } from '@tower/shared';

export interface ModelOption {
  value: string;
  label: string;
}

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Codex の説明文（英語）から平易な日本語の一言を作る。当てはまらなければ付けない */
export function codexHint(description: string): string | null {
  const d = description.toLowerCase();
  if (/most capable|most powerful|frontier/.test(d)) return '最高性能・難しい仕事向け';
  if (/previous[- ]generation/.test(d)) return '一世代前';
  if (/fast|affordable|lightweight/.test(d)) return '速い・軽い';
  if (/balanced/.test(d)) return 'バランス型';
  if (/workhorse|everyday/.test(d)) return '普段づかい';
  return null;
}

/** config.toml の先頭（最初の [表] より前）にある model = "..." */
export function configModel(toml: string): string | null {
  const head = toml.split(/^[ \t]*\[/m)[0];
  return head.match(/^[ \t]*model[ \t]*=[ \t]*["']([^"']+)["']/m)?.[1] ?? null;
}

interface CachedModel {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
}

/** Codex で選べるモデル（隠しモデルを除いて Codex の並び順）と、既定のモデルの名前 */
export function codexModels(home = codexHome()): { models: ModelOption[]; defaultModel: string | null } {
  let list: CachedModel[] = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    if (Array.isArray(j?.models)) list = j.models.filter((m: CachedModel) => typeof m?.slug === 'string');
  } catch {
    // まだ一度も Codex を動かしていない
  }
  const name = (m: CachedModel) => m.display_name || m.slug!;
  const shown = list.filter((m) => m.visibility !== 'hide').sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  const models = shown.map((m) => {
    const hint = codexHint(m.description ?? '');
    return { value: m.slug!, label: hint ? `${name(m)}（${hint}）` : name(m) };
  });
  let configured: string | null = null;
  try {
    configured = configModel(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  } catch {
    // 設定ファイルが無い
  }
  const slug = configured ?? shown[0]?.slug ?? null;
  const hit = list.find((m) => m.slug === slug);
  return { models, defaultModel: slug ? (hit ? name(hit) : slug) : null };
}

/** Claude のモデル指定（"opus[1m]" や "claude-sonnet-5"）を画面の名前に */
export function claudeModelName(raw: string): string {
  const s = raw.toLowerCase().replace(/\[.*?\]/g, '');
  const hit = MODEL_CHOICES.find((m) => m.value && s.includes(m.value));
  return hit ? modelLabel(hit.value) : raw;
}

/** Claude の既定のモデルの名前。設定が無ければ null（Claude Code 自身の既定） */
export function claudeDefaultModel(home = claudeHome(), env = process.env): string | null {
  if (env.ANTHROPIC_MODEL?.trim()) return claudeModelName(env.ANTHROPIC_MODEL.trim());
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))?.model;
    return typeof raw === 'string' && raw.trim() ? claudeModelName(raw.trim()) : null;
  } catch {
    return null;
  }
}
