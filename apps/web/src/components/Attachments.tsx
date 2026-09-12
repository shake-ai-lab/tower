// 指示に添える画像・ファイル。貼り付け（Ctrl+V）・ドラッグ・「ファイルを添える」ボタンの 3 通りで足せる。
// 中身は base64 にしてサーバーへ送る（保存とエージェントへの渡し方はサーバーが決める）。
import { useRef, useState } from 'react';
import { ATTACH_LIMITS, type Attachment, type AttachmentUpload } from '@tower/shared';
import { btn } from '../lib';

interface Item extends AttachmentUpload {
  id: string;
  size: number;
  /** 画像ならサムネイル用の data: URL */
  preview?: string;
}

/** 大きすぎる画像は長い辺をここまで縮める（AI はどのみち縮めて見るので、送る量だけ減らす） */
const MAX_EDGE = 2000;
const SHRINKABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('読み込めませんでした'));
    r.readAsDataURL(blob);
  });
}

/** 長い辺が MAX_EDGE を超える画像を縮める。縮められなければ元のまま */
async function shrink(file: File): Promise<Blob> {
  if (!SHRINKABLE.has(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = MAX_EDGE / Math.max(bmp.width, bmp.height);
    if (scale >= 1) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, file.type, 0.9));
    return out ?? file;
  } catch {
    return file;
  }
}

/** 貼り付けた画像は名前が「image.png」になるので、いつ貼ったか分かる名前にする */
function nameOf(file: File, pasted: boolean): string {
  if (!pasted || !/^image\.\w+$/.test(file.name)) return file.name || 'file';
  const t = new Date().toLocaleTimeString('ja-JP', { hour12: false }).replace(/:/g, '');
  return `貼り付け-${t}.${file.name.split('.').pop()}`;
}

export function useAttachments() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const add = async (files: File[], pasted = false) => {
    if (!files.length) return;
    setError(null);
    const room = ATTACH_LIMITS.count - items.length;
    if (room <= 0) {
      setError(`添えられるのは 1 回に ${ATTACH_LIMITS.count} 個までです`);
      return;
    }
    const mb = Math.round(ATTACH_LIMITS.fileBytes / 1024 / 1024);
    const added: Item[] = [];
    const problems: string[] = [];
    for (const f of files.slice(0, room)) {
      const name = nameOf(f, pasted);
      try {
        const blob = await shrink(f);
        if (blob.size > ATTACH_LIMITS.fileBytes) {
          problems.push(`「${name}」は大きすぎます（1 つ ${mb}MB まで）`);
          continue;
        }
        const url = await readDataUrl(blob);
        const mime = blob.type || f.type || 'application/octet-stream';
        added.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name,
          mime,
          size: blob.size,
          data: url.slice(url.indexOf(',') + 1),
          preview: mime.startsWith('image/') ? url : undefined,
        });
      } catch {
        problems.push(`「${name}」を読み込めませんでした`);
      }
    }
    if (files.length > room) problems.push(`添えられるのは 1 回に ${ATTACH_LIMITS.count} 個までです`);
    // 読み込んでいる間に別の貼り付け・ドロップが重なっても上限を超えないように、足す時点でもう一度切る
    let dropped = 0;
    setItems((cur) => {
      const next = [...cur, ...added].slice(0, ATTACH_LIMITS.count);
      dropped = cur.length + added.length - next.length;
      return next;
    });
    if (dropped > 0) problems.push(`添えられるのは 1 回に ${ATTACH_LIMITS.count} 個までです`);
    if (problems.length) setError([...new Set(problems)].join('。'));
  };

  return {
    items,
    error,
    dragging,
    add,
    remove: (id: string) => setItems((cur) => cur.filter((x) => x.id !== id)),
    clear: () => {
      setItems([]);
      setError(null);
    },
    /** サーバーへ送る形 */
    uploads: (): AttachmentUpload[] => items.map(({ name, mime, data }) => ({ name, mime, data })),
    /** 文字入力欄に付ける: 画像を貼り付けたら添付にする（文字の貼り付けはそのまま） */
    onPaste: (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.files];
      if (!files.length) return;
      e.preventDefault();
      void add(files, true);
    },
    /** 落とせる場所に付ける */
    dropProps: {
      onDragOver: (e: React.DragEvent) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        // 子要素（入力欄など）の上に移っただけでは消さない
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setDragging(false);
      },
      onDrop: (e: React.DragEvent) => {
        setDragging(false);
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        e.preventDefault();
        void add(files);
      },
    },
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

/** 「ファイルを添える」ボタン（エクスプローラーから選ぶ） */
export function AttachButton({ state, disabled }: { state: AttachmentsState; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        title="画像やファイルを指示に添えます。画像は貼り付け（Ctrl+V）やドラッグでも添えられます"
        className={`${btn.base} ${btn.ghost}`}
      >
        📎 ファイルを添える
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void state.add([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** 送る前の添付の一覧（✕ で外せる） */
export function AttachList({ state }: { state: AttachmentsState }) {
  if (!state.items.length && !state.error) return null;
  return (
    <div className="space-y-1">
      {state.items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {state.items.map((a) => (
            <div key={a.id} className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 pl-1 pr-1.5 py-1 max-w-[220px]">
              {a.preview ? (
                <img src={a.preview} alt={a.name} className="w-9 h-9 object-cover rounded bg-black shrink-0" />
              ) : (
                <span className="w-9 h-9 flex items-center justify-center rounded bg-zinc-800 shrink-0">📄</span>
              )}
              <div className="min-w-0">
                <div className="text-xs text-zinc-200 truncate" title={a.name}>
                  {a.name}
                </div>
                <div className="text-[10px] text-zinc-500">{fmtSize(a.size)}</div>
              </div>
              <button
                type="button"
                onClick={() => state.remove(a.id)}
                title="外す"
                className="ml-0.5 text-zinc-500 hover:text-zinc-200 shrink-0"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {state.error && <div className="text-xs text-red-400">{state.error}</div>}
    </div>
  );
}

/** 年表に出す、送った添付（画像は小さく見せてクリックで拡大、それ以外は開く） */
export function SentAttachments({ list }: { list: Attachment[] }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {list.map((a) =>
        a.mime.startsWith('image/') ? (
          <button key={a.file} onClick={() => setOpen(a)} title={`${a.name}（クリックで拡大）`} className="rounded border border-zinc-700 overflow-hidden hover:border-sky-500">
            <img src={a.url} alt={a.name} className="w-[96px] h-[64px] object-cover bg-black" />
          </button>
        ) : (
          <a
            key={a.file}
            href={a.url}
            className="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-300 hover:border-sky-500 max-w-[220px]"
            title={`${a.name}（${fmtSize(a.size)}）`}
          >
            📄 <span className="truncate">{a.name}</span>
          </a>
        ),
      )}
      {open && (
        <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6 cursor-zoom-out" onClick={() => setOpen(null)}>
          <img src={open.url} alt={open.name} className="max-w-[92vw] max-h-[88vh] object-contain rounded shadow-2xl" />
          <div className="absolute top-3 left-4 text-xs text-zinc-300">{open.name} — クリックで閉じる</div>
        </div>
      )}
    </div>
  );
}
