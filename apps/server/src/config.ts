// 設定: ~/.tower/config.json（無ければ既定値を書き出す）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TowerConfig {
  /** 127.0.0.1 = このPCのみ。0.0.0.0 にすると同じWi-Fiのスマホからも開ける */
  host: string;
  port: number;
  /** この下のフォルダを「プロジェクト」として一覧に出す */
  projectRoots: string[];
  /** 報告のたびにプロジェクトのテストを Tower 側で走らせて裏取りする（プロジェクトの .tower.json の "verify" で上書き可） */
  autoVerify: boolean;
  /** VS Code 連携で許可を Tower で答える時、何秒待ってから元の画面に任せるか */
  bridgeWaitSeconds: number;
}

export const DATA_DIR = path.join(os.homedir(), '.tower');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function defaultRoots(): string[] {
  return [path.join(os.homedir(), 'project'), path.join(os.homedir(), 'projects')].filter((p) => fs.existsSync(p));
}

export function loadConfig(): TowerConfig {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const base: TowerConfig = {
    host: '127.0.0.1',
    port: 4800,
    projectRoots: defaultRoots(),
    autoVerify: true,
    bridgeWaitSeconds: 90,
  };
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(base, null, 2));
    return base;
  }
  try {
    return { ...base, ...(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<TowerConfig>) };
  } catch (e) {
    console.warn(`[config] ${CONFIG_PATH} を読めません。既定値で続行します:`, e);
    return base;
  }
}
