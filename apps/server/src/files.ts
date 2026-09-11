// 画面からの直接編集（Monaco）とエクスプローラ: セッションの作業フォルダ内のファイルを一覧・読む・書く。フォルダの外には絶対に出さない。
import fs from 'node:fs';
import path from 'node:path';
import { imageType, type FileContent, type TreeEntry, type TreeResponse } from '@tower/shared';

const MAX_BYTES = 1024 * 1024;
/** 画像はそのまま画面に送るので、少し大きくても許す */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 一覧に出さない重いフォルダ（中を見ても利用者の役に立たず、数が膨大） */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.next', '.turbo', '.parcel-cache', '.tower']);
/** 1 つのフォルダで一覧に出す上限 */
const MAX_ENTRIES = 500;

/** 作業フォルダ内の絶対パスに解決する。相対でも絶対でも受けるが、フォルダの外に出るものは拒否 */
export function resolveInside(dir: string, rel: string): string {
  const base = path.resolve(dir);
  const abs = path.resolve(base, rel);
  const back = path.relative(base, abs);
  if (!back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error('作業フォルダの外のファイルは開けません');
  }
  // シンボリックリンクやWindowsのジャンクション経由でも作業フォルダ外へ出さない。
  const realBase = fs.realpathSync(base);
  let existing = abs;
  while (!fs.existsSync(existing)) {
    // 壊れたリンクは新規ファイルとして扱わない。
    try { if (fs.lstatSync(existing).isSymbolicLink()) throw new Error('リンク先が見つかりません'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    existing = path.dirname(existing);
  }
  const realBack = path.relative(realBase, fs.realpathSync(existing));
  if (realBack === '..' || realBack.startsWith(`..${path.sep}`) || path.isAbsolute(realBack)) {
    throw new Error('作業フォルダの外を指すリンクは開けません');
  }
  return abs;
}

const toRel = (dir: string, abs: string) => path.relative(path.resolve(dir), abs).split(path.sep).join('/');

const byName = (a: string, b: string) => a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });

/** 作業フォルダの 1 階層分。rel が空なら作業フォルダそのもの */
export function listDir(dir: string, rel: string): TreeResponse {
  const abs = rel ? resolveInside(dir, rel) : path.resolve(dir);
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    throw new Error(`フォルダを開けません: ${rel || '(作業フォルダ)'}`);
  }
  const dirs: TreeEntry[] = [];
  const files: TreeEntry[] = [];
  const skipped: string[] = [];
  for (const e of ents) {
    const p = toRel(dir, path.join(abs, e.name));
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) skipped.push(e.name);
      else dirs.push({ name: e.name, path: p, kind: 'dir' });
    } else if (e.isFile() || e.isSymbolicLink()) {
      let size: number | undefined;
      try {
        size = fs.statSync(path.join(abs, e.name)).size;
      } catch {
        /* 壊れたリンクなど。大きさ無しで出す */
      }
      files.push({ name: e.name, path: p, kind: 'file', size });
    }
  }
  dirs.sort((a, b) => byName(a.name, b.name));
  files.sort((a, b) => byName(a.name, b.name));
  const all = [...dirs, ...files];
  return { path: rel, entries: all.slice(0, MAX_ENTRIES), skipped: skipped.sort(byName), truncated: Math.max(0, all.length - MAX_ENTRIES) };
}

/** 画像をそのまま返すための場所と種類。画像以外は断る（文字のファイルは readFileContent、それ以外は画面で開けない） */
export function resolveImage(dir: string, rel: string): { abs: string; mime: string; size: number } {
  return checkImage(resolveInside(dir, rel), rel);
}

/** 画像として返せるか（種類・存在・大きさ）。場所が安全かは呼ぶ側で確かめる */
export function checkImage(abs: string, rel = abs): { abs: string; mime: string; size: number } {
  const mime = imageType(abs);
  if (!mime) throw new Error('画像ではないので、この形式では開けません');
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`ファイルが見つかりません: ${rel}`);
  }
  if (!st.isFile()) throw new Error('ファイルではありません（フォルダなど）');
  if (st.size > MAX_IMAGE_BYTES) throw new Error('大きすぎるので画面では開けません（20MB まで）');
  return { abs, mime, size: st.size };
}

export function readFileContent(dir: string, rel: string): FileContent {
  const abs = resolveInside(dir, rel);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`ファイルが見つかりません: ${rel}`);
  }
  if (!st.isFile()) throw new Error('ファイルではありません（フォルダなど）');
  if (st.size > MAX_BYTES) throw new Error('大きすぎるので画面では開けません（1MB まで）');
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) throw new Error('文字のファイルではない（画像など）ので画面では開けません');
  return { path: toRel(dir, abs), content: buf.toString('utf8'), size: st.size };
}

/** 書き込む。既存ファイルが CRLF ならそれに合わせる（改行だけ変わって差分が全行になるのを防ぐ） */
export function writeFileContent(dir: string, rel: string, content: string): string {
  const abs = resolveInside(dir, rel);
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('大きすぎるので保存できません（1MB まで）');
  let text = content;
  try {
    if (fs.readFileSync(abs, 'utf8').includes('\r\n')) text = content.replace(/\r?\n/g, '\r\n');
  } catch {
    /* 新規ファイル */
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return toRel(dir, abs);
}
