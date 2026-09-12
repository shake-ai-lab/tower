// 変更内容の取得。git があれば作業ツリーの差分、無ければ「触ったファイル」の現在の中身を返す。
import fs from 'node:fs';
import path from 'node:path';
import type { ChangedFile, ChangesResponse, LineMark } from '@tower/shared';
import { resolveInside } from './files.ts';
import { git, isGitRepo } from './worktree.ts';

const MAX_FILE = 200 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024;

export function collectHistory(dir: string): NonNullable<ChangesResponse['history']> {
  const result = git(dir, ['log', '--all', '--topo-order', '-40', '--format=%H%x1f%P%x1f%s%x1f%D%x1f%an%x1f%aI%x1f%B%x00']);
  if (!result.ok || !result.out) return [];
  return result.out.split('\0').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [hash, parents, subject, refs, author, date, message] = line.split('\x1f');
    return { hash, parents: parents ? parents.split(' ') : [], subject, refs, author, date, message };
  });
}

/** 行の横の印に直す。-U0 の差分の見出し（@@ -a,b +c,d @@）だけを見る */
export function parseLineMarks(diff: string): LineMark[] {
  const marks: LineMark[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const removed = m[1] === undefined ? 1 : Number(m[1]);
    const start = Number(m[2]);
    const added = m[3] === undefined ? 1 : Number(m[3]);
    if (added === 0) {
      // 消えただけ: start は消えた所の直前の行（先頭で消えた時は 0）
      marks.push({ kind: 'deleted', start: Math.max(1, start), end: Math.max(1, start) });
      continue;
    }
    const changed = Math.min(removed, added);
    if (changed) marks.push({ kind: 'modified', start, end: start + changed - 1 });
    if (added > changed) marks.push({ kind: 'added', start: start + changed, end: start + added - 1 });
  }
  return marks;
}

/**
 * 1 ファイル分の「変わった行」（エディタの行の横の印）。git が無ければ null
 * @param base 比較の起点（collectChanges と同じ）
 */
export function lineMarks(dir: string, rel: string, base = 'HEAD'): LineMark[] | null {
  const abs = resolveInside(dir, rel);
  if (!isGitRepo(dir)) return null;
  const p = path.relative(path.resolve(dir), abs).split(path.sep).join('/');
  if (!git(dir, ['ls-files', '--error-unmatch', '--', p]).ok) {
    // .gitignore で外したものは変更扱いしない。新しく作ったファイルは全部の行が「足した行」
    if (git(dir, ['check-ignore', '-q', '--', p]).ok) return [];
    try {
      const text = fs.readFileSync(abs, 'utf8');
      const n = text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0);
      return n > 0 ? [{ kind: 'added', start: 1, end: n }] : [];
    } catch {
      return [];
    }
  }
  return parseLineMarks(git(dir, ['diff', '--no-color', '--no-ext-diff', '-U0', base, '--', p]).out);
}

/** 未追跡ファイルを「全行追加」の diff に見せる */
function pseudoAddDiff(rel: string, content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return [`--- /dev/null`, `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}

/** 見せても仕方がない生成物（テストが作るキャッシュ、依存、ビルド結果）。未追跡ファイルの一覧から外す */
const JUNK_RE =
  /(^|\/)(__pycache__|node_modules|\.venv|venv|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache|coverage|\.DS_Store|Thumbs\.db)(\/|$)|\.(pyc|pyo|class|o|obj|exe|dll|so|dylib|log|tmp)$/i;

/** 先頭 8KB に NUL があればバイナリ扱い */
function looksBinary(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8000);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).includes(0);
  } catch {
    return false;
  }
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

/**
 * @param dir     差分を取るフォルダ（分離した作業場所ならそのフォルダ）
 * @param touched git 無しの時に見せる「触ったファイル」
 * @param base    比較の起点。通常は HEAD。分離した作業場所では元のブランチとの分岐点（取り込み済みの分は出ない）
 */
export function collectChanges(dir: string, touched: string[], base = 'HEAD'): ChangesResponse {
  const files: ChangedFile[] = [];
  let total = 0;
  const push = (f: ChangedFile) => {
    if (total > MAX_TOTAL) return;
    total += f.diff.length;
    files.push(f);
  };

  if (isGitRepo(dir)) {
    const seen = new Set<string>();
    // 追跡済みファイルの変更（コミット済み + 未コミット）を base と比べる
    // 作業フォルダがリポジトリの途中（サブフォルダや分離した作業場所の一部）でも、パスは作業フォルダからの相対にする
    const prefix = git(dir, ['rev-parse', '--show-prefix']).out.trim();
    const named = git(dir, ['diff', '--name-status', '-M', '--relative', base]).out;
    for (const line of named.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const code = parts[0][0];
      const rel = parts[parts.length - 1];
      seen.add(rel);
      if (code === 'D') {
        push({ path: rel, status: 'D', diff: git(dir, ['diff', base, '--', rel]).out });
      } else {
        const d = git(dir, ['diff', base, '--', rel]).out;
        push({ path: rel, status: code === 'A' ? 'A' : 'M', diff: d || '(差分なし: 内容は同じ)' });
      }
    }
    // 未追跡ファイルは「全行追加」として見せる
    const status = git(dir, ['status', '--porcelain', '--untracked-files=all']).out;
    for (const line of status.split(/\r?\n/)) {
      if (!line.startsWith('??')) continue;
      let rel = line.slice(3).replace(/^"|"$/g, '');
      // status の未追跡ファイルはリポジトリの根からのパス
      if (prefix) {
        if (!rel.startsWith(prefix)) continue;
        rel = rel.slice(prefix.length);
      }
      if (seen.has(rel)) continue;
      if (JUNK_RE.test(rel) || looksBinary(path.join(dir, rel))) continue;
      const content = readCapped(path.join(dir, rel));
      if (content !== null) push({ path: rel, status: 'A', diff: pseudoAddDiff(rel, content) });
    }
    return { isGit: true, branch: git(dir, ['branch', '--show-current']).out.trim(), history: collectHistory(dir), files };
  }
  const projectPath = dir;

  // git 無し: 触ったファイルの現在の中身だけ
  for (const abs of touched) {
    const rel = path.relative(projectPath, abs) || path.basename(abs);
    const content = readCapped(abs);
    if (content === null) push({ path: rel, status: 'D', diff: '(ファイルが見つかりません)' });
    else push({ path: rel, status: '?', diff: pseudoAddDiff(rel, content) });
  }
  return { isGit: false, files };
}
