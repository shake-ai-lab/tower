// 画面からの直接編集（Monaco）: セッションの作業フォルダ内のファイルを読む・書く。フォルダの外には絶対に出さない。
import fs from 'node:fs';
import path from 'node:path';
import type { FileContent } from '@tower/shared';

const MAX_BYTES = 1024 * 1024;

/** 作業フォルダ内の絶対パスに解決する。相対でも絶対でも受けるが、フォルダの外に出るものは拒否 */
export function resolveInside(dir: string, rel: string): string {
  const base = path.resolve(dir);
  const abs = path.resolve(base, rel);
  const back = path.relative(base, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error('作業フォルダの外のファイルは開けません');
  }
  return abs;
}

const toRel = (dir: string, abs: string) => path.relative(path.resolve(dir), abs).split(path.sep).join('/');

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
