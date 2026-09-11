// エディタの道具: 作業フォルダの全ファイル一覧（ファイル名で開く）と、全体の文字検索。
// git があれば .gitignore に従う（ビルド結果や依存を出さない）。無ければ重いフォルダだけ飛ばして辿る。
import fs from 'node:fs';
import path from 'node:path';
import { imageType, type FileListResponse, type SearchMatch, type SearchResponse } from '@tower/shared';
import { SKIP_DIRS } from './files.ts';
import { git, isGitRepo } from './worktree.ts';

const MAX_FILES = 20000;
const MAX_SEARCH_BYTES = 1024 * 1024;
const MAX_MATCHES = 1000;
const MAX_PER_FILE = 100;
const SEARCH_MS = 4000;
const LINE_CHARS = 160;

const skipped = (rel: string) => rel.split('/').some((part) => SKIP_DIRS.has(part));

export function listAllFiles(dir: string): FileListResponse {
  const base = path.resolve(dir);
  let files: string[] = [];
  if (isGitRepo(base)) {
    const r = git(base, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    // 消したが記録には残っているファイルは開けないので外す
    files = [...new Set(r.out.split('\0').filter(Boolean))].filter((rel) => !skipped(rel) && fs.existsSync(path.join(base, rel)));
  } else {
    const walk = (rel: string) => {
      if (files.length > MAX_FILES) return;
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(p);
        } else if (e.isFile()) files.push(p);
      }
    };
    walk('');
  }
  files.sort((a, b) => a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' }));
  return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}

/** 長い行は見つかった所の前後だけにする */
function excerpt(line: string, index: number, length: number): { text: string; at: number } {
  if (line.length <= LINE_CHARS) return { text: line, at: index };
  const start = Math.max(0, index - 40);
  const text = (start > 0 ? '…' : '') + line.slice(start, start + LINE_CHARS) + (start + LINE_CHARS < line.length ? '…' : '');
  return { text, at: index - start + (start > 0 ? 1 : 0) };
}

/** 文字をそのまま探す（正規表現ではない）。既定は大文字・小文字を区別しない */
export function searchText(dir: string, query: string, caseSensitive = false): SearchResponse {
  const base = path.resolve(dir);
  const result: SearchResponse = { query, files: [], total: 0, truncated: false };
  if (!query) return result;
  const needle = caseSensitive ? query : query.toLowerCase();
  const list = listAllFiles(base);
  result.truncated = list.truncated;
  const deadline = Date.now() + SEARCH_MS;
  for (const rel of list.files) {
    if (Date.now() > deadline) {
      result.truncated = true;
      break;
    }
    if (imageType(rel)) continue;
    let buf: Buffer;
    try {
      const abs = path.join(base, rel);
      if (fs.statSync(abs).size > MAX_SEARCH_BYTES) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const text = buf.toString('utf8');
    if (!(caseSensitive ? text : text.toLowerCase()).includes(needle)) continue;
    const matches: SearchMatch[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
      for (let from = 0; ; ) {
        const index = hay.indexOf(needle, from);
        if (index < 0) break;
        result.total++;
        if (matches.length < MAX_PER_FILE && result.total <= MAX_MATCHES) {
          matches.push({ line: i + 1, column: index + 1, length: query.length, ...excerpt(lines[i], index, query.length) });
        }
        from = index + Math.max(1, needle.length);
      }
    }
    if (matches.length) result.files.push({ path: rel, matches });
    if (result.total > MAX_MATCHES) result.truncated = true;
  }
  return result;
}
