// Markdown を「読みやすく表示」する。文書に書かれた HTML は消毒してから出す（仕込まれたスクリプトを動かさない）
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { resolveLink } from './editor-tools';

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
