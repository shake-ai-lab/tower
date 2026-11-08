import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { formUploadConfig, type AttachmentUpload, type Session } from '@tower/shared';
import { checkUploads, saveAttachments } from './attachments.ts';

/** Only the current form can request a user-selected file or directory. */
export function saveFormAttachment(session: Session | undefined, body: unknown): { uri: string; name: string } {
  if (!session || !/^[\w-]+$/.test(session.id)) throw new Error('タスクが見つかりません。');
  const input = body as { requestId?: unknown; fieldPath?: unknown; attachment?: AttachmentUpload; directoryPath?: unknown } | null;
  const pending = session.pending;
  if (!input || pending?.kind !== 'form' || input.requestId !== pending.id) throw new Error('この入力フォームはもう有効ではありません。');
  if (!Array.isArray(input.fieldPath) || input.fieldPath.length > 40 || input.fieldPath.some(p => typeof p !== 'string' || p.length > 500)) throw new Error('添付先の項目が不正です。');
  const config = formUploadConfig(pending.schema, input.fieldPath);
  if (!config) throw new Error('この項目ではファイルを追加できません。');
  if (config.kind === 'directory') {
    if (input.attachment || typeof input.directoryPath !== 'string' || !path.isAbsolute(input.directoryPath)) throw new Error('フォルダーの絶対パスを指定してください。');
    const directory = fs.realpathSync(input.directoryPath);
    if (!fs.statSync(directory).isDirectory()) throw new Error('指定された場所はフォルダーではありません。');
    return { uri: pathToFileURL(directory).href, name: path.basename(directory) || directory };
  }
  if (input.directoryPath !== undefined || !input.attachment) throw new Error('ファイルを選択してください。');
  const [upload] = checkUploads([input.attachment]);
  if (typeof upload.mime !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(upload.data) || upload.data.length % 4 !== 0) throw new Error('添付の形式が不正です。');
  const mime = upload.mime.split(';')[0].trim().toLowerCase();
  const extension = path.extname(upload.name).toLowerCase();
  if (config.accept.length && !config.accept.some(raw => {
    const accept = raw.toLowerCase();
    return accept === '*/*' || (accept.startsWith('.') ? extension === accept : accept.endsWith('/*') ? mime.startsWith(accept.slice(0, -1)) : mime === accept);
  })) throw new Error(`選択できるファイル形式: ${config.accept.join(', ')}`);
  const suffix = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
  const [saved] = saveAttachments(session.id, [{ ...upload, name: `${randomUUID()}${suffix}` }]);
  return { uri: pathToFileURL(saved.path).href, name: upload.name };
}
