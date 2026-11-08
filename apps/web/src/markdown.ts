// Markdown を「読みやすく表示」する。文書に書かれた HTML は消毒してから出す（仕込まれたスクリプトを動かさない）
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { resolveLink } from './editor-tools';
import { findFileRefs, toWorkPath, type FileRef } from './reply-links';

/** 画像の相対パスは作業フォルダの画像として出す（imageUrl で URL にする） */
export function renderMarkdown(src: string, fromFile: string, imageUrl: (path: string) => string): string {
  const html = DOMPurify.sanitize(marked.parse(src, { gfm: true, async: false }) as string);
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const img of tpl.content.querySelectorAll('img')) {
    const p = resolveLink(fromFile, img.getAttribute('src') ?? '');
    if (p) img.setAttribute('src', imageUrl(p));
  }
  return tpl.innerHTML;
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * エージェントの返事を表示用の HTML にする。消毒した後の HTML の上で、ファイルの場所らしい所（`コード`・文中のパス・
 * リンク・画像）を data-file 付きのリンクにする（押した時の処理は components/Reply.tsx。HTML を文字でつなげて足すことはしない）。
 * files = 作業フォルダ（root）と画像の URL の作り方。無ければファイルへのリンクは作らない。作業フォルダの外を指すものもリンクにしない
 */
export function renderReply(src: string, files: { root: string; imageUrl: (path: string) => string } | null): string {
  const html = DOMPurify.sanitize(marked.parse(src, { gfm: true, breaks: true, async: false }) as string);
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const root = tpl.content;
  const ref = (token: string, bare: boolean) => (files ? toWorkPath(token, files.root, { bare }) : null);
  const mark = (el: Element, r: FileRef) => {
    el.setAttribute('data-file', r.path);
    if (r.line) el.setAttribute('data-line', String(r.line));
    el.setAttribute('title', `${r.path}${r.line ? `（${r.line} 行目）` : ''} を開く`);
    el.classList.add('file-ref');
  };
  const fileLink = (r: FileRef) => {
    const a = document.createElement('a');
    a.setAttribute('href', '#');
    mark(a, r);
    return a;
  };

  // リンク: 外のページはそのまま（押すと別の窓）。ファイルを指すものは作業フォルダの中だけ開く。それ以外は押しても何もしない
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noreferrer noopener');
      continue;
    }
    a.removeAttribute('href');
    const r = href ? ref(decode(href), true) : null;
    if (r) {
      a.setAttribute('href', '#');
      mark(a, r);
    }
  }
  // 画像: 作業フォルダの中の画像は表示して、押すとエディタで開く。外を指すものは代わりの文字にする（壊れた画像を出さない）
  for (const img of root.querySelectorAll('img')) {
    const s = img.getAttribute('src') ?? '';
    if (/^(https?:|data:image\/)/i.test(s)) continue;
    const r = s ? ref(decode(s), true) : null;
    if (r && files) {
      img.setAttribute('src', files.imageUrl(r.path));
      img.setAttribute('loading', 'lazy');
      mark(img, r);
    } else img.replaceWith(document.createTextNode(img.getAttribute('alt') || s));
  }
  if (!files) return tpl.innerHTML;

  // `コード` の中身がそのままファイルの場所なら、コードごとリンクにする（コードの塊 pre の中は対象外）
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre, a')) continue;
    const r = ref(code.textContent ?? '', true);
    if (!r) continue;
    const a = fileLink(r);
    code.replaceWith(a);
    a.appendChild(code);
  }
  // 文中のパス（区切りのあるものだけ）。リンク・コードの中は上で済ませたので触らない
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest('a, code, pre')) texts.push(n as Text);
  for (const node of texts) {
    const text = node.data;
    const hits = findFileRefs(text)
      .map((h) => ({ ...h, r: ref(h.token, false) }))
      .filter((h): h is typeof h & { r: FileRef } => !!h.r);
    if (!hits.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const h of hits) {
      if (h.start > at) frag.append(text.slice(at, h.start));
      const a = fileLink(h.r);
      a.textContent = h.token;
      frag.append(a);
      at = h.end;
    }
    if (at < text.length) frag.append(text.slice(at));
    node.replaceWith(frag);
  }
  return tpl.innerHTML;
}
