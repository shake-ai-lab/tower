// Codex の実行ファイルを探す。
// インストーラには Codex の本体（378MB）を入れないので、VS Code の Codex 拡張（openai.chatgpt）に入っている codex.exe を使う。
// ログインは ~/.codex を VS Code と共有するので、VS Code でログイン済みなら Tower でもそのまま使える。
// 探す順: 環境変数 TOWER_CODEX_PATH → VS Code の拡張（いちばん新しい版）→ 開発用の node_modules/@openai/codex
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface CodexBin {
  /** 起動するもの（実行ファイル、または node） */
  command: string;
  /** command の後ろに付ける引数（node で動かす時は bin/codex.js） */
  args: string[];
  /** Codex SDK に渡す実行ファイル（codexPathOverride）。npm の時は無し（SDK が自分で探す） */
  exe?: string;
  /** 画面に出す一言 */
  label: string;
}

const EXT_DIRS = ['.vscode', '.vscode-insiders'].map((d) => path.join(os.homedir(), d, 'extensions'));

/** 「openai.chatgpt-26.908.40401-win32-x64」の版を数の並びに */
function versionOf(name: string): number[] {
  return (name.match(/^openai\.chatgpt-(\d+(?:\.\d+)*)/)?.[1] ?? '0').split('.').map(Number);
}
function newer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** VS Code の Codex 拡張に入っている codex 本体（いちばん新しい版） */
export function vscodeCodex(dirs = EXT_DIRS): { exe: string; version: string } | null {
  const exeName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const found: { exe: string; version: number[]; name: string }[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith('openai.chatgpt-'));
    } catch {
      continue;
    }
    for (const name of names) {
      let plats: string[] = [];
      try {
        plats = fs.readdirSync(path.join(dir, name, 'bin'));
      } catch {
        continue;
      }
      for (const plat of plats) {
        const exe = path.join(dir, name, 'bin', plat, exeName);
        if (fs.existsSync(exe)) found.push({ exe, version: versionOf(name), name });
      }
    }
  }
  found.sort((a, b) => newer(b.version, a.version));
  return found[0] ? { exe: found[0].exe, version: found[0].version.join('.') } : null;
}

export function findCodexBin(): CodexBin | null {
  const env = process.env.TOWER_CODEX_PATH;
  if (env && fs.existsSync(env)) return { command: env, args: [], exe: env, label: `指定の Codex（${env}）` };
  const vs = vscodeCodex();
  if (vs) return { command: vs.exe, args: [], exe: vs.exe, label: `VS Code の Codex 拡張（${vs.version}）` };
  try {
    const bin = require.resolve('@openai/codex/bin/codex.js');
    return { command: process.execPath, args: [bin], label: '開発用の Codex（node_modules）' };
  } catch {
    return null;
  }
}

export const CODEX_MISSING = 'Codex が見つかりません。VS Code に OpenAI の Codex 拡張機能を入れると、Tower からも Codex のタスクを始められます（ログインも VS Code と共通です）';
