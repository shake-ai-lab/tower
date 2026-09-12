// 設定: ~/.tower/config.json（無ければ既定値を書き出す）。画面の「設定」からも書き換えられる（saveConfig）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TowerSettings } from '@tower/shared';

/** 項目の意味は packages/shared の TowerSettings を参照 */
export type TowerConfig = TowerSettings;

/** 置き場所。動作確認で利用者のデータ（~/.tower）と混ぜたくない時は TOWER_DATA_DIR で別の場所にできる */
export const DATA_DIR = process.env.TOWER_DATA_DIR ? path.resolve(process.env.TOWER_DATA_DIR) : path.join(os.homedir(), '.tower');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function defaultRoots(): string[] {
  return [path.join(os.homedir(), 'project'), path.join(os.homedir(), 'projects')].filter((p) => fs.existsSync(p));
}

function defaults(): TowerConfig {
  return {
    host: '127.0.0.1',
    port: 4800,
    projectRoots: defaultRoots(),
    autoVerify: true,
    bridgeWaitSeconds: 90,
    reformatReports: true,
    externalKeepHours: 24,
    feedbackFile: path.join(DATA_DIR, 'feedback.md'),
    autoResume: true,
  };
}

/** ファイルにある分だけ（無い項目は既定値で埋めない）。壊れていれば空 */
function readFile(): Partial<TowerConfig> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<TowerConfig>;
  } catch (e) {
    if (fs.existsSync(CONFIG_PATH)) console.warn(`[config] ${CONFIG_PATH} を読めません。既定値で続行します:`, e);
    return {};
  }
}

export function loadConfig(): TowerConfig {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const base = defaults();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(base, null, 2));
    return applyEnvOverrides(base);
  }
  return applyEnvOverrides({ ...base, ...readFile() });
}

/** デスクトップ版や動作確認で、設定ファイルを触らずに待ち受けを変えたい時の逃げ道（起動時と設定保存時の両方で効かせる） */
export function applyEnvOverrides(cfg: TowerConfig): TowerConfig {
  if (process.env.TOWER_PORT && Number(process.env.TOWER_PORT) > 0) cfg.port = Number(process.env.TOWER_PORT);
  if (process.env.TOWER_HOST) cfg.host = process.env.TOWER_HOST;
  return cfg;
}

/**
 * 画面からの変更をファイルに書く。既定値で埋めた全項目を書き出す（手で開いた時に何が変えられるか分かるように）。
 * 途中で落ちても壊れたファイルが残らないように、隣に書いてから置き換える
 */
export function saveConfig(patch: Partial<TowerConfig>): TowerConfig {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const next: TowerConfig = { ...defaults(), ...readFile(), ...patch };
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

/** 画面から来た設定を確かめる。おかしければ利用者向けの日本語で投げる */
export function validateSettings(body: Partial<TowerSettings>): Partial<TowerSettings> {
  const out: Partial<TowerSettings> = {};
  const int = (v: unknown, name: string, min: number, max: number): number => {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${name}は ${min} から ${max} までの整数にしてください`);
    }
    return n;
  };
  if (body.host !== undefined) {
    const h = String(body.host).trim();
    if (!h || /\s/.test(h)) throw new Error('待ち受けアドレスが空か、空白を含んでいます');
    out.host = h;
  }
  if (body.port !== undefined) out.port = int(body.port, 'ポート', 1, 65535);
  if (body.projectRoots !== undefined) {
    if (!Array.isArray(body.projectRoots)) throw new Error('プロジェクトのフォルダは一覧で送ってください');
    const roots: string[] = [];
    for (const r of body.projectRoots) {
      const p = String(r).trim();
      if (!p) continue;
      if (!path.isAbsolute(p)) throw new Error(`フォルダは絶対パス（C:\\... のような書き方）で指定してください: ${p}`);
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`フォルダが見つかりません: ${p}`);
      const norm = path.resolve(p);
      if (!roots.some((x) => x.toLowerCase() === norm.toLowerCase())) roots.push(norm);
    }
    out.projectRoots = roots;
  }
  if (body.autoVerify !== undefined) out.autoVerify = !!body.autoVerify;
  if (body.reformatReports !== undefined) out.reformatReports = !!body.reformatReports;
  if (body.autoResume !== undefined) out.autoResume = !!body.autoResume;
  if (body.bridgeWaitSeconds !== undefined) out.bridgeWaitSeconds = int(body.bridgeWaitSeconds, '待つ秒数', 10, 600);
  if (body.externalKeepHours !== undefined) out.externalKeepHours = int(body.externalKeepHours, '保持する時間', 0, 24 * 30);
  if (body.feedbackFile !== undefined) {
    const f = String(body.feedbackFile).trim();
    if (!f) throw new Error('「気づいたこと」のファイルが空です');
    if (!path.isAbsolute(f)) throw new Error('「気づいたこと」のファイルは絶対パスで指定してください');
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) throw new Error('「気づいたこと」のファイルにフォルダが指定されています');
    out.feedbackFile = path.resolve(f);
  }
  return out;
}
