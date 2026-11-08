// タスクの作業の記録（コミット）。報告のたびに、そのタスクが変えたファイルを Tower が記録する（1 回の報告 = 1 つの記録）。
// 記録にはタスクの印（最後の段落の「Tower-Task: <id>」の行）を付け、Git のグラフでどのタスクの記録か分かるようにする。
// エージェントが自分で記録した時も、コマンドの出力（[main 1a2b3c4] 件名）から拾ってタスクに結びつける。
import fs from 'node:fs';
import path from 'node:path';
import { workDir, type ChangesResponse, type HistoryCommit, type Report, type ReportOutcome, type Session, type TaskCommit } from '@tower/shared';
import { collectChanges } from './diff.ts';
import type { Hub } from './hub.ts';
import { firstLine } from './humanize.ts';
import { git, gitCommit, isGitRepo } from './worktree.ts';

let enabled = true;
export function setAutoCommitEnabled(v: boolean) {
  enabled = v;
}
export const autoCommitEnabled = () => enabled;

const TRAILER_RE = /^Tower-Task:[ \t]*([0-9a-f][0-9a-f-]{7,})[ \t]*$/im;

/** コミットの説明からタスクの印を読む。無ければ null */
export function taskIdOf(message: string | undefined): string | null {
  return (message && TRAILER_RE.exec(message)?.[1]) || null;
}

const PREFIX: Partial<Record<ReportOutcome, string>> = { partial: '（途中）', question: '（途中）', failed: '（失敗）' };

/** 記録の説明: 1 行目 = 何を頼まれたか、本文 = やったこと、最後 = タスクの印 */
export function commitMessage(s: Pick<Session, 'id' | 'title'>, report: Report | null): string {
  const request = firstLine(report?.request || s.title).trim() || s.title;
  const subject = `${(report && PREFIX[report.outcome]) ?? ''}${request.length > 60 ? `${request.slice(0, 60)}…` : request}`;
  const body = (report?.summary ?? []).slice(0, 5).map((l) => `- ${l}`).join('\n');
  return [subject, body, `Tower-Task: ${s.id}`].filter(Boolean).join('\n\n');
}

export type CommitOutcome =
  /** largeNote = 大きすぎて記録に入れなかったファイルの説明 */
  | { kind: 'committed'; commit: TaskCommit; files: string[]; message: string; largeNote?: string }
  /** message が null = 記録するものが無いので黙って見送る */
  | { kind: 'skipped'; message: string | null }
  | { kind: 'failed'; message: string };

/** 合流（マージ）・リベースなどの途中か。途中で一部だけ記録すると git が断るか、合流の記録を壊す */
function operationInProgress(root: string): boolean {
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some((p) => {
    const r = git(root, ['rev-parse', '--git-path', p]);
    return r.ok && fs.existsSync(path.resolve(root, r.out));
  });
}

/** status --porcelain -z の中身（リポジトリの根からのパス）。名前を変えた記録は新旧どちらのパスも入れる */
export function parseStatusZ(out: string): string[] {
  const tokens = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 4) continue;
    paths.push(t.slice(3));
    if (/[RC]/.test(t[0])) paths.push(tokens[++i] ?? '');
  }
  return paths.filter(Boolean);
}

const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** 自動の記録に入れない大きさ。git の記録は後から消せず、生成した画像や PDF を報告のたびに積むとリポジトリが膨らみ続ける */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_BINARY_BYTES = 1024 * 1024;

/** 先頭に NUL を含むものをバイナリ（画像・PDF・動画など）とみなす */
function looksBinary(abs: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(8000);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** 自動の記録に入れない大きなファイル（リポジトリの根からのパス）。消したファイルは大きさが無いので入れる */
export function tooLargeToRecord(root: string, paths: string[]): string[] {
  return paths.filter((p) => {
    let size: number;
    try {
      const st = fs.statSync(path.join(root, p));
      if (!st.isFile()) return false;
      size = st.size;
    } catch {
      return false;
    }
    return size > MAX_TEXT_BYTES || (size > MAX_BINARY_BYTES && looksBinary(path.join(root, p)));
  });
}

const sizeNote = (big: string[]) =>
  `大きなファイル ${big.length} 件（1MB を超える画像・PDF などと、5MB を超えるファイル）は、リポジトリが膨らまないよう自動の記録には入れていません（ファイルはそのまま残っています）: ${big.slice(0, 5).join('、')}${big.length > 5 ? ' ほか' : ''}`;

/**
 * タスクの変更を記録する。
 * - 分離した作業場所: そのタスク専用なので、作業場所の変更を全部記録する
 * - プロジェクトのフォルダで直接: 他のタスクや利用者の書きかけを混ぜないよう、このタスクが触ったファイルだけ記録する
 *   （利用者が先に git に載せていた（ステージしていた）他のファイルもそのまま残す）
 */
export function commitTaskWork(s: Session, report: Report | null): CommitOutcome {
  const dir = s.workspace ? s.workspace.root : workDir(s);
  if (!fs.existsSync(dir) || !isGitRepo(dir)) return { kind: 'skipped', message: null };
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { kind: 'skipped', message: null };
  const root = path.resolve(top.out);
  if (operationInProgress(root)) {
    // 分離した作業場所の合流の途中は、取り込みの時に Tower が締めくくる
    return { kind: 'skipped', message: s.workspace ? null : '変更の記録（コミット）は見送りました。このプロジェクトは git の合流（マージ）などの途中です' };
  }
  const dirty = parseStatusZ(git(root, ['status', '--porcelain', '-z', '--untracked-files=all'], { raw: true }).out);
  let picked = dirty;
  if (!s.workspace) {
    // 作業フォルダからのパスに「リポジトリの根から作業フォルダまで」を足す（根の書き方の違い＝短い名前などに左右されない）
    const base = workDir(s);
    const prefix = git(base, ['rev-parse', '--show-prefix']).out;
    const touched = new Set<string>();
    for (const f of s.changedFiles) {
      const rel = path.relative(base, path.resolve(base, f));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) touched.add(key(prefix + rel.split(path.sep).join('/')));
    }
    picked = dirty.filter((p) => touched.has(key(p)));
  }
  const big = new Set(tooLargeToRecord(root, picked));
  if (big.size) picked = picked.filter((p) => !big.has(p));
  if (!picked.length) return { kind: 'skipped', message: big.size ? sizeNote([...big]) : null };

  const input = picked.join('\0');
  const spec = ['--pathspec-from-file=-', '--pathspec-file-nul'];
  const add = git(root, ['--literal-pathspecs', 'add', '-A', ...spec], { input });
  if (!add.ok) return { kind: 'failed', message: `変更を記録（コミット）できませんでした: ${(add.err || add.out).slice(0, 400)}` };
  const message = commitMessage(s, report);
  // ファイルを指定した記録は、そのファイルだけを記録する（先にステージされていた他のファイルは入れない）
  const c = gitCommit(root, ['--literal-pathspecs', 'commit', '-q', '-m', message, ...spec], { input });
  if (!c.ok) {
    return { kind: 'failed', message: `変更を記録（コミット）できませんでした。コミット前のチェックなどで止まった可能性があります: ${(c.err || c.out).slice(0, 400)}` };
  }
  const hash = git(root, ['rev-parse', 'HEAD']).out;
  return {
    kind: 'committed',
    commit: { hash, subject: firstLine(message), files: picked.length, at: Date.now() },
    files: picked,
    message,
    ...(big.size ? { largeNote: sizeNote([...big]) } : {}),
  };
}

// ---- エージェントが自分で記録した時 ----

/** git commit のコマンドか（git -C … commit、&& でつないだものも含む） */
export const isCommitCommand = (command: string) => /\bgit\b[^\n;&|]*\scommit\b/.test(command);

/** git commit の出力の「[main 1a2b3c4] 件名」「[main (root-commit) 1a2b3c4] 件名」から、記録したコミットを拾う */
export function commitsInOutput(output: string): { short: string; subject: string }[] {
  return [...output.matchAll(/^\[[^\]\r\n]*?\s([0-9a-f]{7,40})\]\s+(.*?)\r?$/gm)].map((m) => ({ short: m[1], subject: m[2].trim() }));
}

/** エージェントが自分でコミットしたら、そのコミットをタスクの記録に加える */
export function recordAgentCommits(hub: Hub, sessionId: string, command: string, output: string) {
  if (!isCommitCommand(command)) return;
  const found = commitsInOutput(output);
  const s = hub.get(sessionId);
  if (!found.length || !s) return;
  const dir = s.workspace?.root ?? workDir(s);
  const known = new Set((s.commits ?? []).map((c) => c.hash));
  const added: TaskCommit[] = [];
  for (const f of found) {
    const r = git(dir, ['rev-parse', '--verify', '-q', `${f.short}^{commit}`]);
    if (r.ok && r.out && !known.has(r.out)) {
      known.add(r.out);
      added.push({ hash: r.out, subject: f.subject, at: Date.now() });
    }
  }
  if (added.length) hub.update(sessionId, { commits: [...(s.commits ?? []), ...added].slice(-200) });
}

// ---- Git のグラフとタスクを結びつける ----

/** 履歴の各コミットに、記録したタスクを付ける（タスクが覚えているコミットか、説明のタスクの印で見分ける） */
export function linkTasks(history: HistoryCommit[], sessions: Iterable<Session>): HistoryCommit[] {
  const byId = new Map<string, Session>();
  const byHash = new Map<string, Session>();
  for (const s of sessions) {
    byId.set(s.id, s);
    for (const c of s.commits ?? []) byHash.set(c.hash, s);
  }
  return history.map((h) => {
    const id = byHash.get(h.hash)?.id ?? taskIdOf(h.message);
    if (!id) return h;
    const s = byId.get(id);
    return { ...h, task: { id, title: s ? s.title : null } };
  });
}

/** 何も入っていない状態（最初のコミットの手前）を表す git の決まった値 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * プロジェクトのフォルダで直接作業するタスクの変更。
 * 報告のたびに記録するので、最後の記録（HEAD）と比べるとタスクの変更が見えなくなる。
 * 記録したことがあれば、このタスクの最初の記録の手前と比べ、このタスクの記録に入ったファイルと、まだ記録していない変更だけを出す
 */
export function directChanges(s: Session): ChangesResponse {
  const dir = workDir(s);
  const plain = () => collectChanges(dir, s.changedFiles);
  const hashes = (s.commits ?? []).map((c) => c.hash);
  if (!hashes.length || !isGitRepo(dir)) return plain();
  // 書き直されて（リベースなどで）無くなったコミットは除く
  const check = git(dir, ['cat-file', '--batch-check'], { input: `${hashes.join('\n')}\n` }).out.split(/\r?\n/);
  const alive = hashes.filter((h, i) => check[i]?.startsWith(`${h} commit`));
  if (!alive.length || !git(dir, ['merge-base', '--is-ancestor', alive[0], 'HEAD']).ok) return plain();
  const parent = git(dir, ['rev-parse', '--verify', '-q', `${alive[0]}^`]);
  const base = parent.ok && parent.out ? parent.out : EMPTY_TREE;
  const names = (args: string[]) => git(dir, args).out.split(/\r?\n/).filter(Boolean);
  const keep = new Set([
    ...names(['log', '--no-walk', '--name-only', '--format=', '--relative', ...alive]),
    ...names(['diff', '--name-only', '--relative', 'HEAD']),
    ...names(['ls-files', '--others', '--exclude-standard']),
  ]);
  const r = collectChanges(dir, s.changedFiles, base);
  return { ...r, files: r.files.filter((f) => keep.has(f.path)), against: 'このタスクが始めてからの変更です（記録（コミット）した分も含みます）。' };
}

/** エージェントへの注意書き（システムプロンプトに追記）。自動で記録しない設定なら無し */
export function commitNote(): string | null {
  if (!enabled) return null;
  return [
    '# 変更の記録（コミット）',
    '- 報告のたびに、あなたが変えたファイルを Tower が自動で記録（コミット）する。利用者に頼まれた時以外は、自分でコミットしなくてよい',
    '- 1 回の報告が 1 つの記録になり、報告の「依頼」と「やったこと」がその記録の説明になる。後から見て何をしたか分かるように書く',
  ].join('\n');
}
