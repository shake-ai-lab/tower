// エディタの道具の計算だけ（画面に依存しない。node --test で確かめる）

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

/** 飛び飛びに当たる文字の位置（見つからなければ null） */
function subsequence(text: string, token: string, from: number): number[] | null {
  const idx: number[] = [];
  let at = from;
  for (const ch of token) {
    const i = text.indexOf(ch, at);
    if (i < 0) return null;
    idx.push(i);
    at = i + 1;
  }
  return idx;
}

/**
 * ファイル名で開く（Ctrl+P）の当たり方。VS Code と同じく「名前の一部」「飛び飛びの文字」「空白で区切った複数語」で当たる。
 * 当たらなければ null。score が大きいほど上に出す。hits は強調する文字の位置
 */
export function matchFile(path: string, query: string): { score: number; hits: number[] } | null {
  const lower = path.toLowerCase();
  const nameStart = lower.lastIndexOf('/') + 1;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  const hits = new Set<number>();
  for (const t of tokens) {
    const inName = lower.indexOf(t, nameStart);
    const anywhere = lower.indexOf(t);
    let found: number[] | null;
    if (inName >= 0) {
      score += 1000 - (inName - nameStart) * 10 + (inName === nameStart ? 200 : 0);
      found = range(inName, t.length);
    } else if (anywhere >= 0) {
      score += 500 - anywhere;
      found = range(anywhere, t.length);
    } else if ((found = subsequence(lower, t, nameStart))) {
      score += 300 - (found.at(-1)! - found[0]);
    } else if ((found = subsequence(lower, t, 0))) {
      score += 100 - (found.at(-1)! - found[0]) / 10;
    } else return null;
    for (const i of found) hits.add(i);
  }
  return { score: score - path.length / 10, hits: [...hits].sort((a, b) => a - b) };
}

export function rankFiles(files: string[], query: string, limit = 50): { path: string; hits: number[] }[] {
  if (!query.trim()) return files.slice(0, limit).map((path) => ({ path, hits: [] }));
  const out: { path: string; hits: number[]; score: number }[] = [];
  for (const path of files) {
    const m = matchFile(path, query);
    if (m) out.push({ path, ...m });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return out.slice(0, limit).map(({ path, hits }) => ({ path, hits }));
}

/** 文書の中の相対リンク・画像を、作業フォルダからのパスにする。外部の URL・ページ内リンク・フォルダの外は null */
export function resolveLink(fromFile: string, href: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const clean = href.split(/[?#]/)[0];
  if (!clean) return null;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    /* 壊れた % はそのまま */
  }
  const parts = decoded.startsWith('/') ? [] : fromFile.split('/').slice(0, -1);
  for (const p of decoded.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts.join('/') || null;
}
