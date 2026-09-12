// エージェントの生のツール呼び出しを、コードを読まない人が判断できる日本語に翻訳する。
import path from 'node:path';
import { imageType, type RiskLevel } from '@tower/shared';

const str = (v: unknown, max = 200): string => {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
};
const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? '';

/**
 * 指示文から一覧用の題名を作る。VS Code 拡張は指示の前に <ide_opened_file>…</ide_opened_file> や
 * <system-reminder>…</system-reminder> のようなメタを差し込むので、それを外してから最初の行を取る
 */
export function promptTitle(p: string, max = 60): string {
  const cleaned = p
    .replace(/<([a-z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[a-z][\w-]*(\s[^>]*)?\/>/gi, '');
  const line = cleaned.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? firstLine(p).trim();
  return line.slice(0, max);
}

/**
 * 裏で動かしていたコマンドが終わった時、Claude Code は <task-notification>…</task-notification> を
 * 利用者の発言として差し込んでくる。記号のまま見せず「終わりました」の一言にする。該当しなければ null
 */
export function describeTaskNotification(p: string): string | null {
  const m = p.match(/^\s*<task-notification>([\s\S]*?)<\/task-notification>/);
  if (!m) return null;
  const tag = (name: string) => m[1].match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '';
  const status = tag('status');
  const what = tag('summary').match(/"([^"]+)"/)?.[1];
  const subject = what ? `裏で動かしていた作業（${str(what, 60)}）` : '裏で動かしていた作業';
  if (/fail|error/i.test(status)) return `${subject}が失敗しました`;
  if (/kill|stop|cancel/i.test(status)) return `${subject}を止めました`;
  return `${subject}が終わりました`;
}

const SUBAGENT_VERB: Record<string, string> = {
  Read: 'ファイルを読んで',
  Grep: 'コードを検索して',
  Glob: 'ファイルを探して',
  Bash: 'コマンドを実行して',
  PowerShell: 'コマンドを実行して',
  Edit: 'ファイルを直して',
  MultiEdit: 'ファイルを直して',
  Write: 'ファイルを書いて',
  WebFetch: 'Web ページを読んで',
  WebSearch: 'Web を検索して',
};

/** サブエージェントの途中経過（SDK の task_progress の一言）。英語のままなら、使っている道具から日本語の一言を作って断片を添える */
export function describeSubagentProgress(summary: string, lastTool?: string): string {
  if (hasJapanese(summary)) return `サブエージェント: ${str(summary, 60)}`;
  const verb = (lastTool && SUBAGENT_VERB[lastTool]) || '作業して';
  return `サブエージェントが${verb}います（${str(summary, 50)}）`;
}

/** ひらがな・カタカナ・漢字を含むか（英語のままの description を使わない判定） */
export function hasJapanese(s: string): boolean {
  return /[぀-ヿ㐀-鿿]/.test(s);
}

/**
 * シェルで包まれたコマンドから中身を取り出す。Codex は `"C:\…\powershell.exe" -Command 'npm test'` の形で動かすので、
 * そのままだと「powershell を動かしています」にしかならない。包まれていなければそのまま返す
 */
export function unwrapShell(command: string): string {
  const m = command
    .trim()
    .match(/^(?:"[^"]*?(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?"|\S*?(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?)\s+(?:\S+\s+)*?(?:-Command|-c|\/c|-lc)\s+([\s\S]+)$/i);
  if (!m) return command;
  return m[1].trim().replace(/^["']/, '').replace(/["']$/, '').trim();
}

/** 先頭のコマンド名を正規化する。パス付き・拡張子付き・引用符付きでも `vitest` `python` のように見えるようにする */
function commandHead(segment: string): string {
  const [first = '', ...rest] = segment.split(/\s+/);
  const name = path
    .basename(first.replace(/^["'&]+|["']+$/g, ''))
    .replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return [name, ...rest].join(' ');
}

/**
 * コマンドの中で「主役」の部分を取り出す。先頭行を `&&` `||` `|` `;` で区切り、
 * `cd X` や環境変数の指定など前置きは飛ばして最初の意味のある部分を返す
 */
function mainSegment(command: string): string {
  const parts = firstLine(command.trim()).split(/&&|\|\|?|;/);
  for (const raw of parts) {
    const seg = raw
      .trim()
      .replace(/^\(+/, '')
      .replace(/^(sudo\s+|\w+=\S*\s+)+/, '')
      .trim();
    if (!seg) continue;
    // `set` は前置きだが PowerShell の `Set-Content` などは主役なので残す
    // 今いる場所を出すだけの Get-Location / pwd も前置き（Codex がよく先頭に付ける）
    if (/^(cd|pushd|Set-Location|sl|export|set|Get-Location|pwd)\b(?!-)/i.test(seg) || /^\$env:/i.test(seg)) continue;
    return commandHead(seg);
  }
  return '';
}

const RUNNERS = '(?:npm|pnpm|yarn|bun)';
/** `npm run -w apps/web build` のような、run の後ろに付くオプション（`-w` やその値を動作名にしない） */
const RUN_FLAGS = '(?:(?:-w|--workspace|--prefix|-C)\\s+\\S+\\s+|-\\S+\\s+)*';
/** コマンドの主役部分 → 日本語の一言。上から順に当てはめる */
const COMMAND_PHRASES: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
  [/^git\s+status\b/i, 'git の状態を見ています'],
  [/^git\s+diff\b/i, '差分を見ています'],
  [/^git\s+log\b/i, '履歴を見ています'],
  [/^git\s+show\b/i, '変更内容を見ています'],
  [/^git\s+branch\b/i, 'ブランチを見ています'],
  [/^git\s+(add|commit)\b/i, '変更を記録（コミット）しています'],
  [/^git\s+push\b/i, '変更を送信（push）しています'],
  [/^git\s+(pull|fetch)\b/i, '最新の変更を取り込んでいます'],
  [/^git\s+(checkout|switch|merge|rebase|stash)\b/i, 'ブランチを切り替え・統合しています'],
  [/^git\s+worktree\b/i, '作業場所を整えています'],
  [/^git\b/i, 'git を操作しています'],
  [new RegExp(`^${RUNNERS}\\s+(run\\s+)?test\\w*`, 'i'), 'テストを実行しています'],
  [/^(npx\s+)?(vitest|jest|mocha|playwright\s+test)\b/i, 'テストを実行しています'],
  [/^(pytest|cargo\s+test|go\s+test)\b/i, 'テストを実行しています'],
  [/^(node|npx\s+tsx|tsx)\s+--test\b/i, 'テストを実行しています'],
  [/^(npx\s+)?tsc\b.*--noEmit/i, 'コードを点検しています'],
  [new RegExp(`^${RUNNERS}\\s+run\\s+${RUN_FLAGS}(build|compile)\\b`, 'i'), 'ビルドしています'],
  [/^(npx\s+)?(tsc\b|vite\s+build\b)/i, 'ビルドしています'],
  [/^(cargo|go)\s+build\b/i, 'ビルドしています'],
  [new RegExp(`^${RUNNERS}\\s+run\\s+${RUN_FLAGS}(typecheck|lint)\\b`, 'i'), 'コードを点検しています'],
  [/^(npx\s+)?(eslint|prettier|ruff|mypy)\b/i, 'コードを点検しています'],
  [/^(npm|pnpm|yarn|bun|pip|pip3|uv|cargo|go)\s+(install|add|i|get)\b/i, 'パッケージを入れています'],
  [new RegExp(`^${RUNNERS}\\s+run\\s+${RUN_FLAGS}([^-\\s]\\S*)`, 'i'), (m) => `${m[1]} を実行しています`],
  [new RegExp(`^${RUNNERS}\\s+start\\b`, 'i'), 'start を実行しています'],
  [/^(ls|dir|find|tree|Get-ChildItem|gci|fd)\b/i, 'ファイルの一覧を見ています'],
  [/^(cat|head|tail|less|more|type|Get-Content|gc|wc|bat)\b/i, 'ファイルの中身を見ています'],
  [/^sed\s+-n\b/i, 'ファイルの中身を見ています'],
  [/^(grep|egrep|rg|ag|Select-String|sls)\b/i, 'コードを検索しています'],
  [/^(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i, 'Web に接続しています'],
  [/^(mkdir|md|cp|mv|touch|New-Item|ni|Copy-Item|Move-Item)\b/i, 'ファイルを整理しています'],
  [/^(rm|del|rmdir|Remove-Item|ri)\b/i, 'ファイルを消しています'],
  [/^(taskkill|kill|pkill|killall|Stop-Process)\b/i, 'プロセスを止めています'],
  [/^(node|python|python3|py|deno|ruby|php|tsx|ts-node)\b/i, 'スクリプトを実行しています'],
  [/^npx\s+(tsx|ts-node)\b/i, 'スクリプトを実行しています'],
  [/^bun\s+run\b/i, 'スクリプトを実行しています'],
  [/^docker\b/i, 'Docker を操作しています'],
  [/^(echo|printf|Write-Output|Write-Host)\b/i, '表示を確認しています'],
];

/**
 * コマンドの中身から「何をしているか」を平易な日本語で。末尾にコマンドの短い断片を括弧で添える。
 * 例: `cd apps/web && npm run build` → `ビルドしています（cd apps/web && npm run build）`
 */
export function describeCommand(command: string): string {
  command = unwrapShell(command);
  const seg = mainSegment(command);
  const line = firstLine(command.trim());
  // 読む・表示するだけに見えて実は書き込む・消す形（ファイルへのリダイレクト、xargs、find の -exec / -delete）は表より先に決める
  const writes = /(?:^|\s)>>?\s*(?!\/dev\/null|nul\b|&)\S/i.test(line);
  const chains = /\bxargs\b|\s-exec\b|\s-delete\b/i.test(line);
  let phrase = writes ? 'ファイルに書き込んでいます' : 'コマンドを実行しています';
  for (const [re, text] of COMMAND_PHRASES) {
    if (writes || chains) break;
    const m = seg.match(re);
    if (!m) continue;
    phrase = typeof text === 'function' ? text(m) : text;
    break;
  }
  // 改行や制御文字は空白に潰して 1 行に
  const snippet = command.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
  return snippet ? `${phrase}（${str(snippet, 40)}）` : phrase;
}

/** 読むだけと分かるコマンドの頭（PowerShell と、よく使う道具）。これだけで組んだコマンドは Codex の許可を聞かずに通す */
const READ_ONLY_HEADS =
  /^(Get-Content|gc|cat|type|head|tail|Get-ChildItem|gci|ls|dir|tree|Get-Item|gi|Get-ItemProperty|Test-Path|Resolve-Path|Split-Path|Join-Path|Get-Location|gl|pwd|Select-String|sls|rg|grep|findstr|Select-Object|select|Measure-Object|measure|Sort-Object|Group-Object|Format-Table|ft|Format-List|fl|Out-String|Where-Object|where|Get-FileHash|Get-Command|wc|echo|Write-Output)$/i;
const READ_ONLY_GIT = /^git\s+(status|diff|log|show|rev-parse|ls-files|blame|grep)\b/i;
/** どこかに含まれていたら「読むだけ」とは言えないもの（書く・消す・動かす・式を実行する・リダイレクト） */
const NOT_READ_ONLY =
  /(^|[^-\w])(Remove-|Set-|New-|Add-|Clear-|Move-|Copy-|Rename-|Out-File|Invoke-|Start-|Stop-|Restart-|Export-|Install-|Uninstall-|Update-)|\b(iex|rm|del|rmdir|mv|cp)\b|\.(Delete|MoveTo|CopyTo|Create|Write\w*|Kill)\(|>/i;

/** 読むだけのコマンドか（ファイルの中身・一覧・検索・git の状態を見るだけ）。PowerShell の包みは外して見る */
export function isReadOnlyCommand(command: string): boolean {
  // 2>&1 や >$null は書き込みではないので先に外す
  const cmd = unwrapShell(command)
    .replace(/\d?>\s*(&\d|\$null|nul)(?!\w)/gi, '')
    .trim();
  if (!cmd || NOT_READ_ONLY.test(cmd)) return false;
  const segs = cmd
    .split(/\r?\n|;|\|\||&&|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segs.length > 0 && segs.every((seg) => READ_ONLY_GIT.test(seg) || READ_ONLY_HEADS.test(commandHead(seg).split(/\s+/)[0]));
}

/** 「〜しています」「〜を見ています」「取り込んでいます」を、許可の見出し向けの「〜したい」にする（上の表の言い回しに合わせた変換） */
export function wantPhrase(activity: string): string {
  return activity.replace(/込んでいます$/, '込みたい').replace(/ています$/, 'たい');
}

/** description が日本語ならそれ、英語や空ならコマンドの中身から作った日本語 */
function commandActivity(input: Record<string, unknown>): string {
  const desc = typeof input.description === 'string' ? input.description : '';
  return desc && hasJapanese(desc) ? str(desc, 60) : describeCommand(String(input.command ?? ''));
}

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
      return commandActivity(input);
    case 'WebFetch':
      return `Webページを読んでいます (${str(input.url, 50)})`;
    case 'WebSearch':
      return `Web検索中 (${str(input.query, 40)})`;
    case 'Task':
    case 'Agent': {
      // サブエージェントの説明も英語のままなら見せず、日本語の一言に断片を添える
      const desc = typeof input.description === 'string' ? input.description : '';
      if (desc && hasJapanese(desc)) return `サブエージェント: ${str(desc, 50)}`;
      return desc ? `サブエージェントを動かしています（${str(desc, 50)}）` : 'サブエージェントを動かしています';
    }
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
      // 見出しは日本語の description があればそれ、無ければ（英語なら）コマンドの中身から作る。詳細はコマンド全文
      const cmd = String(input.command ?? '');
      const desc = typeof input.description === 'string' ? input.description : '';
      if (desc && hasJapanese(desc)) return { headline: `コマンドを実行したい: ${desc}`, detail: cmd };
      // コマンドの中身から作った一言は「〜しています」なので、見出しでは「〜したい」にする（「実行したい: 実行しています」と重ねない）
      const what = describeCommand(cmd);
      const i = what.indexOf('（');
      return { headline: wantPhrase(i >= 0 ? what.slice(0, i) : what) + (i >= 0 ? what.slice(i) : ''), detail: cmd };
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
  /^\s*format(\.com)?\s+[a-z]:/i,
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

/** Read で画像を読んだ時、その画像の場所（年表で中身を見せる） */
export function readImage(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'Read' && typeof input.file_path === 'string' && imageType(input.file_path)) return input.file_path;
  return undefined;
}

/** Edit/Write 系から触ったファイルを拾う */
export function touchedFile(toolName: string, input: Record<string, unknown>): string | null {
  if (['Edit', 'MultiEdit', 'Write'].includes(toolName) && typeof input.file_path === 'string') return input.file_path;
  if (toolName === 'NotebookEdit' && typeof input.notebook_path === 'string') return input.notebook_path;
  return null;
}

/**
 * ツール結果を年表用に短くする。
 * 元のツールが分かる時（toolName）は、英語の定型文（"The file … has been updated successfully" 等）を
 * そのまま出さず、何が起きたかを日本語で言う。エラーの時は原文の先頭行を出す方が役に立つので toolName を渡さない
 */
/** ツールの結果（文字列か、文字・画像の塊の並び）から文字だけを取り出す */
export function resultText(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
          .filter(Boolean)
          .join('\n')
      : '';
}

export function summarizeToolResult(content: unknown, toolName?: string, input?: Record<string, unknown>): string {
  const text = resultText(content);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rest = lines.length > 1 ? `（ほか ${lines.length - 1} 行）` : '';
  switch (toolName) {
    case 'Read':
      return `${base(input?.file_path)} を読みました（${lines.length} 行）`;
    case 'Edit':
    case 'MultiEdit':
      return `${base(input?.file_path)} を書き換えました`;
    case 'NotebookEdit':
      return `${base(input?.notebook_path)} を書き換えました`;
    case 'Write':
      return `${base(input?.file_path)} を書きました`;
    case 'TodoWrite':
      return '作業計画を更新しました';
    case 'Task':
    case 'Agent':
      // 裏で動かし始めた時の結果は内部向けの英文（"Async agent launched successfully…"）なので見せない
      return /async agent launched/i.test(text)
        ? 'サブエージェントを裏で動かし始めました（終わると続きを書きます）'
        : `サブエージェントが結果を返しました${lines.length ? `（${lines.length} 行）` : ''}`;
    case 'Bash':
    case 'PowerShell':
      return lines.length ? `${lines[0].trim().slice(0, 120)}${rest}` : '(出力なし)';
    default:
      return firstLine(text).slice(0, 120);
  }
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
