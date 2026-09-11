// 指示に添えた画像・ファイル。~/.tower/attachments/<sessionId>/ に保存し（作業フォルダの外なので差分や取り込みに混ざらない）、
// エージェントには「画像はそのまま見せる / それ以外は保存場所を伝えて読ませる」。
import fs from 'node:fs';
import path from 'node:path';
import { ATTACH_LIMITS, type Attachment, type AttachmentUpload } from '@tower/shared';
import { DATA_DIR } from './config.ts';

export const ATTACH_DIR = path.join(DATA_DIR, 'attachments');

/** 保存した添付。path はサーバー上の絶対パス（画面には出さない） */
export interface SavedAttachment extends Attachment {
  path: string;
}

/** 会話にそのまま載せられる画像の種類 */
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** そのまま載せる画像の上限（API は 1 枚 5MB まで。base64 で 4/3 倍になるので余裕を持たせる） */
const INLINE_MAX = 3.75 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
};

export const attachmentDir = (sessionId: string) => path.join(ATTACH_DIR, sessionId);

/** 画面からの画像として開いてよいもの（それ以外はダウンロードさせる） */
export const isInlineImage = (a: Pick<Attachment, 'mime'>) => INLINE_IMAGE.has(a.mime);

/** Windows で使えない文字とフォルダ区切りを消す */
function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return (base || 'file').slice(-80);
}

/** 保存する前の検査（数・大きさ・中身）。問題があれば利用者向けの日本語で投げる */
export function checkUploads(uploads: AttachmentUpload[] | undefined): AttachmentUpload[] {
  const list = uploads ?? [];
  if (!Array.isArray(list)) throw new Error('添付の形式が不正です');
  if (list.length > ATTACH_LIMITS.count) throw new Error(`添付は 1 回に ${ATTACH_LIMITS.count} 個までです`);
  const mb = Math.round(ATTACH_LIMITS.fileBytes / 1024 / 1024);
  for (const u of list) {
    if (typeof u?.name !== 'string' || typeof u.data !== 'string') throw new Error('添付の形式が不正です');
    // base64 の長さからおおよその大きさを出す（デコードする前に弾く）
    if ((u.data.length * 3) / 4 > ATTACH_LIMITS.fileBytes) throw new Error(`「${u.name}」が大きすぎます（1 つ ${mb}MB まで）`);
  }
  return list;
}

/** 添付を保存して一覧を返す */
export function saveAttachments(sessionId: string, uploads: AttachmentUpload[]): SavedAttachment[] {
  if (!uploads.length) return [];
  const dir = attachmentDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  return uploads.map((u, i) => {
    const name = safeName(u.name);
    const file = `${stamp}-${i + 1}-${name}`;
    const buf = Buffer.from(u.data, 'base64');
    const abs = path.join(dir, file);
    fs.writeFileSync(abs, buf);
    const mime = u.mime || MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';
    return {
      name: u.name,
      file,
      mime,
      size: buf.length,
      url: `/api/sessions/${sessionId}/attachments/${encodeURIComponent(file)}`,
      path: abs,
    };
  });
}

/** 年表・画面向け（サーバー上のパスを外す） */
export const publicRefs = (list: SavedAttachment[]): Attachment[] => list.map(({ path: _p, ...rest }) => rest);

/** 会話にそのまま載せる画像か */
export const canInline = (a: SavedAttachment) => isInlineImage(a) && a.size <= INLINE_MAX;

/**
 * 指示の末尾に足す説明。画像を直接見せる時も保存場所を書いておく（ファイルとして使いたい依頼もあるので）。
 * @param inlined true = 画像そのものを会話に載せている
 */
export function attachmentNote(list: SavedAttachment[], inlined: (a: SavedAttachment) => boolean): string {
  if (!list.length) return '';
  const lines = list.map((a) => `- ${a.name}: ${a.path}${inlined(a) ? '（画像はこのメッセージに付けています）' : ''}`);
  return `\n\n（添付: 利用者が次の画像・ファイルを添えました。依頼に関係するので中身を確認してから作業してください。プロジェクトに置く必要がある時だけ、作業フォルダへコピーしてください）\n${lines.join('\n')}`;
}

/** 保存した添付を読み出す（画面の表示用）。セッションのフォルダの外は読まない */
export function readAttachment(sessionId: string, file: string): { body: Buffer; mime: string } | null {
  if (!/^[\w-]+$/.test(sessionId) || file !== path.basename(file) || file.startsWith('.')) return null;
  const abs = path.join(attachmentDir(sessionId), file);
  if (!fs.existsSync(abs)) return null;
  const ext = path.extname(file).toLowerCase();
  return { body: fs.readFileSync(abs), mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
}

export function removeAttachments(sessionId: string) {
  fs.rmSync(attachmentDir(sessionId), { recursive: true, force: true });
}
