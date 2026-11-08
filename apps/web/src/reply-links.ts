// 返事（エージェントの文章）の中のファイル名を見つけて、作業フォルダからのパスにする。
// 画面に依存しない計算だけ（node --test で確かめる）。押した時に開く処理は components/Reply.tsx

export type FileRef = { path: string; line?: number };

/** 拡張子（英字で始まる 1〜8 文字）。「v1.2」「2026/11/08」のような数字だけのものはファイルとみなさない */
const EXT = String.raw`\.[A-Za-z][A-Za-z0-9]{0,7}`;
const SEG = String.raw`[\w@+\-.]+`;
const NAME = String.raw`[\w@+\-.]*`;
const LINE = String.raw`(?::\d+(?::\d+)?)?`;
/** 文中の URL（この中のファイル名らしきものは拾わない） */
const URL_PART = String.raw`[A-Za-z][A-Za-z0-9+.\-]*:\/\/\S+|www\.\S+`;
/** フォルダの区切りを含むものだけ。区切りの無い「Node.js」「e.g.」のような語を拾わないように */
const PATH_PART =
  String.raw`(?:[A-Za-z]:[\\/]|\/)(?:${SEG}[\\/])*${NAME}${EXT}${LINE}` + '|' + String.raw`(?:\.{1,2}[\\/])?(?:${SEG}[\\/])+${NAME}${EXT}${LINE}`;
const TEXT_RE = new RegExp(String.raw`(${URL_PART})|(?<![\w@+\-./\\:])(${PATH_PART})(?![\w/\\])`, 'g');

/** 区切りの無いファイル名（`package.json` など）をリンクにしてよい拡張子。`console.log`・`process.env` のようなコードの語は拾わない */
const BARE_EXT = new Set(
  ('ts tsx js jsx mjs cjs json jsonc md mdx markdown txt css scss sass less html htm vue svelte astro py rb go rs java kt kts swift ' +
    'c h cc cpp hpp cs php sh bash zsh ps1 psm1 bat cmd yml yaml toml ini cfg conf lock xml svg png jpg jpeg gif webp bmp ico avif pdf csv tsv sql graphql gql prisma proto gradle')
    .split(' '),
);

/** 文の中でファイルの場所らしい所（URL は除く）。start/end は text の中の位置 */
export function findFileRefs(text: string): { start: number; end: number; token: string }[] {
  const out: { start: number; end: number; token: string }[] = [];
  for (const m of text.matchAll(TEXT_RE)) {
    if (m[1] || !m[2]) continue;
    out.push({ start: m.index!, end: m.index! + m[2].length, token: m[2] });
  }
  return out;
}

const norm = (p: string) => p.replace(/\\/g, '/');

/**
 * ファイルの場所らしい文字を、作業フォルダ（root）からのパスにする。開けないもの（URL・フォルダの外・拡張子が無い）は null。
 * bare = 区切りの無い名前も受ける（`コード` の中だけ。拡張子が決まったものに限る）。
 * 末尾の「:12」「#L12」は行として返す
 */
export function toWorkPath(token: string, root: string, { bare = false }: { bare?: boolean } = {}): FileRef | null {
  let p = token.trim();
  if (!p || p.length > 400 || /[\n\r\t<>"'`|*?{}();,=]/.test(p)) return null;
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\//i, '');
    try {
      p = decodeURIComponent(p);
    } catch {
      /* 壊れた % はそのまま */
    }
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(p) || /^www\./i.test(p) || /^(mailto|data|javascript):/i.test(p)) return null;
  if (p.startsWith('~')) return null;

  let line: number | undefined;
  const lm = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(p);
  if (lm) {
    line = Number(lm[1] ?? lm[2]) || undefined;
    p = p.slice(0, lm.index);
  }
  p = norm(p);
  const base = norm(root).replace(/\/+$/, '');
  const winRoot = /^[A-Za-z]:/.test(base);
  // Git Bash の書き方（/c/Users/...）
  if (winRoot && /^\/[A-Za-z]\//.test(p)) p = `${p[1]}:${p.slice(2)}`;
  const absolute = /^[A-Za-z]:\//.test(p) || p.startsWith('/');
  // 空白は、ドライブから始まる場所（「C:\My Folder\a.png」）だけ認める
  if (/\s/.test(p) && !/^[A-Za-z]:\//.test(p)) return null;

  const name = p.split('/').pop() ?? '';
  const ext = /\.([A-Za-z][A-Za-z0-9]{0,7})$/.exec(name)?.[1];
  const dotfile = /^\.[A-Za-z][\w.-]*$/.test(name);
  if (!ext && !dotfile) return null;
  if (!absolute && !p.includes('/')) {
    if (!bare) return null;
    if (!dotfile && !BARE_EXT.has(ext!.toLowerCase())) return null;
  }

  if (absolute) {
    if (!base) return null;
    const a = winRoot ? p.toLowerCase() : p;
    const b = winRoot ? base.toLowerCase() : base;
    if (!a.startsWith(`${b}/`)) return null;
    p = p.slice(base.length + 1);
  }
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  if (!parts.length) return null;
  return line ? { path: parts.join('/'), line } : { path: parts.join('/') };
}

/** 表示用: 作業フォルダの中なら作業フォルダからのパス、外ならそのまま */
export function shortPath(file: string, root: string): string {
  const f = norm(file);
  const b = norm(root).replace(/\/+$/, '');
  const win = /^[A-Za-z]:/.test(b);
  return b && (win ? f.toLowerCase() : f).startsWith(`${win ? b.toLowerCase() : b}/`) ? f.slice(b.length + 1) : file;
}
