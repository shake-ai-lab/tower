// 変更内容の取得。git があれば作業ツリーの差分、無ければ「触ったファイル」の現在の中身を返す。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangedFile, ChangesResponse } from '@tower/shared';

const MAX_FILE = 200 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024;

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

function isGitRepo(cwd: string): boolean {
  const r = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.out.trim() === 'true';
}

/** 未追跡ファイルを「全行追加」の diff に見せる */
function pseudoAddDiff(rel: string, content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return [`--- /dev/null`, `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}

function readCapped(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE) return `(大きすぎるため省略: ${(st.size / 1024).toFixed(0)}KB)`;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function collectChanges(projectPath: string, touched: string[]): ChangesResponse {
  const files: ChangedFile[] = [];
  let total = 0;
  const push = (f: ChangedFile) => {
    if (total > MAX_TOTAL) return;
    total += f.diff.length;
    files.push(f);
  };

  if (isGitRepo(projectPath)) {
    const status = git(projectPath, ['status', '--porcelain', '--untracked-files=all']).out;
    for (const line of status.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const rel = line.slice(3).replace(/^"|"$/g, '');
      const abs = path.join(projectPath, rel);
      if (code === '??') {
        const content = readCapped(abs);
        if (content !== null) push({ path: rel, status: 'A', diff: pseudoAddDiff(rel, content) });
      } else if (code.includes('D')) {
        push({ path: rel, status: 'D', diff: git(projectPath, ['diff', 'HEAD', '--', rel]).out });
      } else {
        const d = git(projectPath, ['diff', 'HEAD', '--', rel]).out;
        push({ path: rel, status: code.includes('A') ? 'A' : 'M', diff: d || '(差分なし: 内容は同じ)' });
      }
    }
    return { isGit: true, files };
  }

  // git 無し: 触ったファイルの現在の中身だけ
  for (const abs of touched) {
    const rel = path.relative(projectPath, abs) || path.basename(abs);
    const content = readCapped(abs);
    if (content === null) push({ path: rel, status: 'D', diff: '(ファイルが見つかりません)' });
    else push({ path: rel, status: '?', diff: pseudoAddDiff(rel, content) });
  }
  return { isGit: false, files };
}
