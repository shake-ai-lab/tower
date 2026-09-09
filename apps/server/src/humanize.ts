// エージェントの生のツール呼び出しを、コードを読まない人が判断できる日本語に翻訳する。
import path from 'node:path';
import type { RiskLevel } from '@tower/shared';

const str = (v: unknown, max = 200): string => {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
};
const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? '';

/** 「今やってること」1行 */
export function describeActivity(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return `${base(input.file_path)} を読んでいます`;
    case 'Glob':
      return `ファイルを探しています (${str(input.pattern, 40)})`;
    case 'Grep':
      return `コードを検索しています (${str(input.pattern, 40)})`;
    case 'Edit':
    case 'MultiEdit':
      return `${base(input.file_path)} を編集しています`;
    case 'Write':
      return `${base(input.file_path)} を書いています`;
    case 'NotebookEdit':
      return `${base(input.notebook_path)} を編集しています`;
    case 'Bash':
    case 'PowerShell':
      return input.description
        ? str(input.description, 60)
        : `コマンド実行中: ${str(firstLine(String(input.command ?? '')), 60)}`;
    case 'WebFetch':
      return `Webページを読んでいます (${str(input.url, 50)})`;
    case 'WebSearch':
      return `Web検索中 (${str(input.query, 40)})`;
    case 'Task':
    case 'Agent':
      return `サブエージェント: ${str(input.description, 50)}`;
    case 'TodoWrite':
      return '作業計画を整理しています';
    case 'AskUserQuestion':
      return 'あなたに質問しています';
    case 'Skill':
      return `スキル実行中 (${str(input.skill, 30)})`;
    default:
      return `${toolName} を実行しています`;
  }
}

/** 許可要求の見出しと詳細 */
export function describePermission(
  toolName: string,
  input: Record<string, unknown>,
): { headline: string; detail: string } {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const cmd = String(input.command ?? '');
      const desc = input.description ? String(input.description) : '';
      return { headline: desc ? `コマンドを実行したい: ${desc}` : 'コマンドを実行したい', detail: cmd };
    }
    case 'Edit':
    case 'MultiEdit': {
      // 何をどう変えるかを許可画面で見せる（判断材料）
      const before = typeof input.old_string === 'string' ? input.old_string : '';
      const after = typeof input.new_string === 'string' ? input.new_string : '';
      const detail = before || after
        ? `${String(input.file_path ?? '')}\n\n--- 変更前\n${str(before, 1200)}\n\n+++ 変更後\n${str(after, 1200)}`
        : String(input.file_path ?? '');
      return { headline: `ファイルを編集したい: ${base(input.file_path)}`, detail };
    }
    case 'Write': {
      const content = typeof input.content === 'string' ? input.content : '';
      const lines = content ? content.split(/\r?\n/).length : 0;
      return {
        headline: `ファイルを作成/上書きしたい: ${base(input.file_path)}${lines ? `（${lines}行）` : ''}`,
        detail: content ? `${String(input.file_path ?? '')}\n\n${str(content, 1500)}` : String(input.file_path ?? ''),
      };
    }
    case 'NotebookEdit':
      return { headline: `ノートブックを編集したい: ${base(input.notebook_path)}`, detail: String(input.notebook_path ?? '') };
    case 'Read':
      return { headline: `ファイルを読みたい: ${base(input.file_path)}`, detail: String(input.file_path ?? '') };
    case 'WebFetch':
      return { headline: 'Webページを取得したい', detail: String(input.url ?? '') };
    case 'WebSearch':
      return { headline: 'Web検索をしたい', detail: String(input.query ?? '') };
    case 'Task':
    case 'Agent':
      return { headline: 'サブエージェントを起動したい', detail: str(input.description, 200) };
    default:
      return { headline: `${toolName} を使いたい`, detail: str(input, 300) };
  }
}

const HIGH = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\brm\s+-r\b/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\brmdir\s+\/s/i,
  /\bdel\s+\/[sq]/i,
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bnpm\s+publish\b/i,
  /\bsudo\b/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\bshutdown\b|\breboot\b/i,
];
const MID = [
  /\bgit\s+push\b/i,
  /\bgit\s+commit\b/i,
  /\bgit\s+(checkout|switch|merge|rebase)\b/i,
  /\b(npm|pnpm|yarn|pip|uv|cargo|go)\s+(install|add|i)\b/i,
  /\bnpx\b/i,
  /\bchmod\b|\bchown\b/i,
  /\bmv\b|\bMove-Item\b/i,
  /\brm\b|\bdel\b|\bRemove-Item\b/i,
  /\bdocker\b/i,
  /\bssh\b|\bscp\b/i,
  /\bkill\b|\bpkill\b|\bkillall\b|\btaskkill\b|Stop-Process/i,
];

export function assessRisk(toolName: string, input: Record<string, unknown>): RiskLevel {
  switch (toolName) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
    case 'WebFetch':
    case 'TodoWrite':
    case 'AskUserQuestion':
      return 'low';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'mid';
    case 'Bash':
    case 'PowerShell': {
      const cmd = String(input.command ?? '');
      if (HIGH.some((r) => r.test(cmd))) return 'high';
      if (MID.some((r) => r.test(cmd))) return 'mid';
      return 'low';
    }
    default:
      return 'mid';
  }
}

/** Edit/Write 系から触ったファイルを拾う */
export function touchedFile(toolName: string, input: Record<string, unknown>): string | null {
  if (['Edit', 'MultiEdit', 'Write'].includes(toolName) && typeof input.file_path === 'string') return input.file_path;
  if (toolName === 'NotebookEdit' && typeof input.notebook_path === 'string') return input.notebook_path;
  return null;
}

/** ツール結果を年表用に短くする */
export function summarizeToolResult(content: unknown): string {
  if (typeof content === 'string') return firstLine(content).slice(0, 120);
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean);
    return firstLine(texts.join(' ')).slice(0, 120);
  }
  return '';
}

/** 年表の詳細欄: Edit は変更前後、Write は中身、コマンドは全文、それ以外は入力 JSON */
export function toolDetail(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Edit' && typeof input.old_string === 'string') {
    return `--- 変更前\n${input.old_string}\n\n+++ 変更後\n${String(input.new_string ?? '')}`.slice(0, 6000);
  }
  if (toolName === 'Write' && typeof input.content === 'string') {
    return `${String(input.file_path ?? '')}\n\n${input.content}`.slice(0, 6000);
  }
  if ((toolName === 'Bash' || toolName === 'PowerShell') && typeof input.command === 'string') {
    return input.command;
  }
  return JSON.stringify(input, null, 2).slice(0, 4000);
}

export { firstLine };
