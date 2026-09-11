// 「気づいたこと」: 利用者が Tower を使いながら書き残す不満・要望・不具合・良かった点。
// 置き場所は 1 つの Markdown（config.feedbackFile）。人も Claude Code もそのまま読める形にし、
// サーバーは「項目を足す」「項目を消す」だけをする。手で書き足した文や「対応:」のメモは触らない。
//
//   - [ ] 2026-09-11 21:30 不満 #k3f9a8
//     許可のカードの文字が小さくて読みにくい
//     場面: 詳細「shakeailab-zenn / 記事の校正」（報告あり）· デスクトップ版 0.2.0
//   - [x] 2026-09-11 21:35 要望 #p2q8zd
//     新しいタスクでプロジェクトが探しにくい
//     場面: 新しいタスク · ブラウザ 0.2.0
//     対応: 検索欄を付けた（abc1234）
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FEEDBACK_KINDS, type CreateFeedbackBody, type FeedbackKind, type FeedbackNote } from '@tower/shared';
import { VERSION } from './version.ts';

export const HEADER = `# Tower を使っていて気づいたこと

Tower の画面右上の「気づいたこと」から書き足されます（手で書き足しても構いません）。
Claude Code に「気づいたことに対応して」と頼むと、このファイルの \`[ ]\` の項目を読んで直します。
直したものは \`[x]\` にして、その項目の下に「対応: 何をしたか」を 1 行足します。
`;

const KIND_LABEL = new Map<FeedbackKind, string>(FEEDBACK_KINDS.map((k) => [k.value, k.label]));
const LABEL_KIND = new Map<string, FeedbackKind>(FEEDBACK_KINDS.map((k) => [k.label, k.value]));

/** 項目の見出し行: "- [ ] 2026-09-11 21:30 不満 #k3f9a8" */
const HEAD_RE = /^- \[( |x|X)\] (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) (\S+) #([a-z0-9]{6,})\s*$/;
const INDENT = '  ';
const MAX_TEXT = 2000;

interface Block {
  note: FeedbackNote;
  /** 見出し行から次の見出し行の手前までの原文（消す時に丸ごと落とす。他の項目は一切書き換えない） */
  raw: string;
}

function parse(text: string): { head: string; blocks: Block[] } {
  const lines = text.split(/\r?\n/);
  const headLines: string[] = [];
  const blocks: Block[] = [];
  let cur: { headLine: string; m: RegExpMatchArray; body: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const m = cur.m;
    const textLines: string[] = [];
    let scene = '';
    let resolution: string | null = null;
    for (const l of cur.body) {
      const t = l.startsWith(INDENT) ? l.slice(INDENT.length) : l.replace(/^\t/, '');
      if (t.startsWith('場面:')) scene = t.slice('場面:'.length).trim();
      else if (t.startsWith('対応:')) resolution = t.slice('対応:'.length).trim();
      else textLines.push(t);
    }
    const createdAt = new Date(+m[2], +m[3] - 1, +m[4], +m[5], +m[6]).getTime();
    blocks.push({
      note: {
        id: m[8],
        createdAt,
        kind: LABEL_KIND.get(m[7]) ?? 'complaint',
        text: textLines.join('\n').trim(),
        scene,
        done: m[1] !== ' ',
        resolution,
      },
      raw: [cur.headLine, ...cur.body].join('\n'),
    });
    cur = null;
  };

  for (const line of lines) {
    const m = line.match(HEAD_RE);
    if (m) {
      flush();
      cur = { headLine: line, m, body: [] };
    } else if (cur) cur.body.push(line);
    else headLines.push(line);
  }
  flush();
  return { head: headLines.join('\n'), blocks };
}

const two = (n: number) => String(n).padStart(2, '0');
const stamp = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

function render(note: FeedbackNote): string {
  const out = [`- [${note.done ? 'x' : ' '}] ${stamp(note.createdAt)} ${KIND_LABEL.get(note.kind) ?? note.kind} #${note.id}`];
  for (const l of note.text.split('\n')) out.push(INDENT + l);
  if (note.scene) out.push(`${INDENT}場面: ${note.scene}`);
  if (note.resolution) out.push(`${INDENT}対応: ${note.resolution}`);
  return out.join('\n');
}

/** 見ていた画面 → 「場面:」の 1 行 */
export function describeScene(ctx: CreateFeedbackBody['context']): string {
  const parts = [ctx?.view?.trim() || '一覧'];
  parts.push(`${ctx?.client === 'desktop' ? 'デスクトップ版' : 'ブラウザ'} ${VERSION}`);
  if (ctx?.width && ctx.width < 768) parts.push('スマホ幅');
  return parts.join(' · ');
}

export class FeedbackFile {
  constructor(readonly file: string) {}

  private read(): string {
    try {
      return fs.readFileSync(this.file, 'utf8');
    } catch {
      return HEADER;
    }
  }

  /** 途中で落ちても壊れたファイルが残らないように、隣に書いてから置き換える */
  private write(text: string) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`);
    fs.renameSync(tmp, this.file);
  }

  list(): FeedbackNote[] {
    if (!fs.existsSync(this.file)) return [];
    return parse(this.read()).blocks.map((b) => b.note);
  }

  add(body: CreateFeedbackBody): FeedbackNote {
    const text = (body.text ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new Error('中身が空です');
    if (text.length > MAX_TEXT) throw new Error(`長すぎます（${MAX_TEXT} 文字まで）`);
    const kind: FeedbackKind = KIND_LABEL.has(body.kind) ? body.kind : 'complaint';
    const note: FeedbackNote = {
      id: randomBytes(4).toString('hex').slice(0, 6),
      createdAt: Date.now(),
      kind,
      text,
      scene: describeScene(body.context),
      done: false,
      resolution: null,
    };
    const cur = this.read().replace(/\s+$/, '');
    this.write(`${cur}\n\n${render(note)}\n`);
    return note;
  }

  remove(id: string): boolean {
    if (!fs.existsSync(this.file)) return false;
    const { head, blocks } = parse(this.read());
    if (!blocks.some((b) => b.note.id === id)) return false;
    const rest = blocks.filter((b) => b.note.id !== id).map((b) => b.raw.replace(/\s+$/, ''));
    this.write([head.replace(/\s+$/, ''), ...rest].join('\n\n') + '\n');
    return true;
  }
}
