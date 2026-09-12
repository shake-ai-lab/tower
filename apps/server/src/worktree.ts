// 作業場所の分離: git worktree でセッション専用のコピーとブランチを作り、同じプロジェクトに複数のセッションを同時に走らせる。
// 取り込み（merge）と後片付けもここ。利用者は git を知らない前提なので、失敗理由は「次に何をすればいいか」が分かる日本語にする。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MergeResult, Workspace } from '@tower/shared';
import { DATA_DIR } from './config.ts';

export const WORKTREE_ROOT = path.join(DATA_DIR, 'worktrees');

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

/**
 * @param opts.input 標準入力に渡す文字列（--pathspec-from-file=- など）
 * @param opts.raw   出力の前後の空白を削らない（status --porcelain は先頭の空白に意味がある）
 */
export function git(cwd: string, args: string[], opts: { input?: string; raw?: boolean } = {}): GitResult {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    input: opts.input,
    // メッセージを英語に固定して判定しやすくする。認証プロンプトで止まらないようにする
    env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
  });
  const out = r.stdout ?? '';
  return { ok: r.status === 0, out: opts.raw ? out : out.trim(), err: (r.stderr ?? '').trim() };
}

/** コミットする。名前・メールアドレスが git に設定されていなければ「Tower」の名前で記録する */
export function gitCommit(dir: string, args: string[], opts: { input?: string } = {}): GitResult {
  const c = git(dir, args, opts);
  if (c.ok || !/tell me who you are|user\.name|user\.email/i.test(`${c.out}\n${c.err}`)) return c;
  return git(dir, ['-c', 'user.name=Tower', '-c', 'user.email=tower@localhost', ...args], opts);
}

export function isGitRepo(dir: string): boolean {
  const r = git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.out === 'true';
}

/** 今開いているブランチ名。detached HEAD なら空 */
export function currentBranch(dir: string): string {
  const r = git(dir, ['branch', '--show-current']);
  return r.ok ? r.out : '';
}

// ---- node_modules の共有 ----
// worktree には .gitignore されたものが無いので、そのままでは npm test すら動かない。
// 元のプロジェクトの node_modules へジャンクション（Windows でも管理者権限なしで作れるリンク）を張って共有する。

/** 深さ制限つきで node_modules を持つフォルダを集める（node_modules の中と隠しフォルダは見ない） */
function dirsWithNodeModules(root: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    if (fs.existsSync(path.join(dir, 'node_modules'))) out.push(dir);
    if (d >= depth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), d + 1);
    }
  };
  walk(root, 0);
  return out;
}

function linkNodeModules(srcRoot: string, dstRoot: string): string[] {
  const linked: string[] = [];
  for (const dir of dirsWithNodeModules(srcRoot)) {
    const rel = path.relative(srcRoot, dir);
    const dst = path.join(dstRoot, rel, 'node_modules');
    if (fs.existsSync(dst)) continue;
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.symlinkSync(path.join(dir, 'node_modules'), dst, 'junction');
      linked.push(rel || '.');
    } catch (e) {
      console.warn(`[worktree] node_modules を共有できません (${dst}):`, e instanceof Error ? e.message : e);
    }
  }
  return linked;
}

/** 消す前にジャンクションを外す。外さずに再帰削除すると、実装によっては元の node_modules まで消えるため */
function unlinkNodeModules(root: string, depth = 4) {
  const walk = (dir: string, d: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.name === 'node_modules') {
        let isLink = false;
        try {
          isLink = fs.lstatSync(p).isSymbolicLink();
        } catch {
          /* ignore */
        }
        if (isLink) {
          try {
            fs.unlinkSync(p);
          } catch {
            try {
              fs.rmdirSync(p);
            } catch {
              /* ignore */
            }
          }
        }
        continue;
      }
      if (e.isDirectory() && !e.name.startsWith('.') && d < depth) walk(p, d + 1);
    }
  };
  walk(root, 0);
}

// ---- 作成・削除 ----

export function createWorktree(projectPath: string, sessionId: string): { workspace: Workspace; linked: string[] } {
  if (!isGitRepo(projectPath)) {
    throw new Error('このプロジェクトは git 管理されていないので、別の作業場所は作れません');
  }
  const top = git(projectPath, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error(`リポジトリの場所が分かりません: ${top.err}`);
  const topAbs = path.resolve(top.out);
  const head = git(projectPath, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) {
    throw new Error('このプロジェクトにはまだ保存（コミット）が1つも無いので、別の作業場所は作れません。先に一度コミットしてください');
  }
  const short = sessionId.slice(0, 8);
  const branch = `tower/${short}`;
  const root = path.join(WORKTREE_ROOT, `${path.basename(topAbs)}-${short}`);
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true });
  const r = git(projectPath, ['worktree', 'add', '-b', branch, root, 'HEAD']);
  if (!r.ok) throw new Error(`別の作業場所を作れませんでした: ${r.err || r.out}`);
  const linked = linkNodeModules(topAbs, root);
  const rel = path.relative(topAbs, path.resolve(projectPath));
  return {
    workspace: {
      path: rel ? path.join(root, rel) : root,
      root,
      branch,
      baseBranch: currentBranch(projectPath),
      baseCommit: head.out,
      lastMerge: null,
    },
    linked,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * worktree とブランチを消す。失敗しても例外は投げず、警告文を返す。
 * Windows では、そのフォルダを作業フォルダにしている子プロセス（エージェント）が終わるまで消せないので、しばらく再試行する。
 */
export async function removeWorktree(projectPath: string, ws: Workspace, timeoutMs = 15_000): Promise<string | null> {
  const warnings: string[] = [];
  const t0 = Date.now();
  let lastErr = '';
  while (fs.existsSync(ws.root)) {
    unlinkNodeModules(ws.root);
    const r = git(projectPath, ['worktree', 'remove', '--force', ws.root]);
    if (!r.ok && fs.existsSync(ws.root)) {
      try {
        fs.rmSync(ws.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    if (!fs.existsSync(ws.root)) break;
    if (Date.now() - t0 > timeoutMs) {
      warnings.push(`作業場所のフォルダを消せませんでした（何かが使用中）: ${ws.root}\n${lastErr || r.err}`);
      break;
    }
    await sleep(500);
  }
  git(projectPath, ['worktree', 'prune']);
  const b = git(projectPath, ['branch', '-D', ws.branch]);
  if (!b.ok && !/not found/i.test(b.err)) warnings.push(`ブランチ ${ws.branch} を消せませんでした: ${b.err}`);
  return warnings.length ? warnings.join('\n') : null;
}

// ---- 取り込み ----

/** 差分の起点: 元のブランチと作業ブランチの分岐点（取り込み済みの分は差分に出ない） */
export function diffBase(ws: Workspace): string {
  if (!fs.existsSync(ws.root)) return ws.baseCommit;
  const base = ws.baseBranch || ws.baseCommit;
  const r = git(ws.root, ['merge-base', base, 'HEAD']);
  return r.ok && r.out ? r.out : ws.baseCommit;
}

/** 変更をすべて記録（コミット）する。合流の途中（競合を直し終えた後）なら、その合流も締めくくる */
function commitEverything(dir: string, msg: string): string | null {
  const status = git(dir, ['status', '--porcelain', '--untracked-files=all']).out;
  const merging = git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok;
  if (!status && !merging) return null;
  const add = git(dir, ['add', '-A']);
  if (!add.ok) return `変更を保存できませんでした: ${add.err}`;
  const c = gitCommit(dir, ['commit', '-q', '-m', msg]);
  if (!c.ok) return `変更を保存（コミット）できませんでした: ${c.err || c.out}`;
  return null;
}

/** 直しかけの競合（まだ合流できていないファイル）が残っているか */
function hasUnresolved(dir: string): boolean {
  return git(dir, ['ls-files', '-u']).out !== '';
}

/** 取り込み先: 元のプロジェクトで今開いているブランチ。ブランチが無ければ今のコミット */
export function originalRef(projectPath: string): string {
  return currentBranch(projectPath) || git(projectPath, ['rev-parse', 'HEAD']).out;
}

const OVERWRITE = /local changes|would be overwritten|untracked working tree files/i;
const CONFLICT = /CONFLICT|Automatic merge failed/i;

/** 年表・画面に出すタスク名（長いものは切る） */
const shortTitle = (t: string) => (t.length > 30 ? `${t.slice(0, 30)}…` : t);

/**
 * 作業場所の変更を元のプロジェクトに取り込む。
 * 1. 作業場所の未保存の変更をコミット 2. 元のプロジェクトで今開いているブランチに merge
 * 元のプロジェクト側に保存していない変更があって重なる時は、利用者に git の作業を頼まず、Tower がその変更を先に記録してから合流する。
 * ただし busyTasks（元のプロジェクトのフォルダで直接作業中のタスク）がある時は、書きかけを記録しないよう待ってもらう。
 * taskId を渡すと、作業場所の記録と合流の記録にタスクの印（Tower-Task: の行）を付ける（Git のグラフでタスクと結びつく）
 */
export function mergeWorktree(projectPath: string, ws: Workspace, title: string, opts: { busyTasks?: string[]; taskId?: string } = {}): MergeResult {
  const tag = (msg: string) => (opts.taskId ? `${msg}\n\nTower-Task: ${opts.taskId}` : msg);
  if (!fs.existsSync(ws.root)) {
    return { ok: false, message: '分離した作業場所のフォルダが見つかりません（消された可能性があります）', files: 0 };
  }
  // 直しかけの競合をそのまま記録すると、競合の印（<<<<<<<）ごと取り込んでしまう
  if (hasUnresolved(ws.root)) {
    return { ok: false, reason: 'unresolved', message: '作業場所に、元のプロジェクトの変更と合わせかけのまま直っていない箇所（競合）が残っています。', files: 0 };
  }
  const commitErr = commitEverything(ws.root, tag(`Tower: ${title}`));
  if (commitErr) return { ok: false, message: commitErr, files: 0 };

  const target = currentBranch(projectPath);
  const targetLabel = target || '今の状態（ブランチなし）';
  const ahead = git(projectPath, ['rev-list', '--count', `HEAD..${ws.branch}`]);
  if (ahead.ok && ahead.out === '0') {
    return { ok: true, message: '取り込む変更はありません（すでに元のプロジェクトに入っています）', files: 0 };
  }
  const files = git(projectPath, ['diff', '--name-only', `HEAD...${ws.branch}`]).out.split(/\r?\n/).filter(Boolean);
  const mergeArgs = ['merge', '--no-edit', '-m', tag(`Tower: ${title} を取り込み`), ws.branch];
  let m = git(projectPath, mergeArgs);
  let saved = 0;
  if (!m.ok && OVERWRITE.test(`${m.out}\n${m.err}`)) {
    const busy = opts.busyTasks ?? [];
    if (busy.length) {
      return {
        ok: false,
        reason: 'busy',
        message:
          `元のプロジェクトのフォルダで直接作業中のタスク（「${busy.slice(0, 2).map(shortTitle).join('」「')}」${busy.length > 2 ? ` ほか ${busy.length - 2} 件` : ''}）が、取り込む内容と同じファイルを書き換えています。` +
          '書きかけの変更を壊さないよう、今は取り込みません。そのタスクの報告が来てから、もう一度「取り込む」を押してください。',
        files: 0,
      };
    }
    // 元のプロジェクト側の保存していなかった変更は、消さず・戻さず、先に記録してから合流し直す
    saved = git(projectPath, ['status', '--porcelain', '--untracked-files=all']).out.split(/\r?\n/).filter(Boolean).length;
    const err = commitEverything(projectPath, `Tower: 「${title}」を取り込む前に、保存していなかった変更を記録`);
    if (err) return { ok: false, message: `元のプロジェクト側の保存していなかった変更を記録できなかったので、取り込めませんでした。${err}`, files: 0 };
    m = git(projectPath, mergeArgs);
  }
  const savedNote = saved ? `（先に、元のプロジェクト側で保存していなかった ${saved} ファイルの変更を記録しました。消してはいません）` : '';
  if (m.ok) {
    return { ok: true, message: `元のプロジェクト（${targetLabel}）に ${files.length} ファイルの変更を取り込みました${savedNote}`, files: files.length };
  }
  const text = `${m.out}\n${m.err}`;
  if (CONFLICT.test(text)) {
    git(projectPath, ['merge', '--abort']);
    return { ok: false, reason: 'conflict', message: `元のプロジェクトと同じ箇所が別々に変わっていて、そのままでは合流できません（競合）。${savedNote}`, files: 0 };
  }
  return { ok: false, message: `取り込みに失敗しました:\n${text.slice(0, 600)}`, files: 0 };
}

/** 取り込みが競合した時に、作業場所の AI へ送る指示。unresolved = 前に合わせかけたまま直っていない */
export function mergeFixPrompt(ref: string, unresolved = false): string {
  return [
    unresolved
      ? `（Tower からの自動メッセージ）利用者が「元のプロジェクトに取り込む」を押しましたが、この作業場所に、元のプロジェクト（${ref}）の変更と合わせかけのまま直っていない箇所（競合）が残っていて取り込めませんでした。残っている競合を直してください。`
      : `（Tower からの自動メッセージ）利用者が「元のプロジェクトに取り込む」を押しましたが、元のプロジェクトにもその後の変更があり、同じ箇所がぶつかって合流できませんでした（競合）。この作業場所で \`git merge ${ref}\` を実行して元のプロジェクトの変更を取り込み、競合を直してください。`,
    '- 元のプロジェクト側の変更と、あなたの変更の両方の狙いを残す。どちらかを捨てるしかない所は勝手に決めず、報告の「判断が必要」で平易な言葉で聞く',
    '- 直したら型チェックやテストで確かめ、合流をコミットして終える（今回はコミットしてよい）。元のプロジェクトのフォルダは触らない',
    '- 終わったら報告を書く。報告の後、Tower がもう一度取り込みます',
  ].join('\n');
}

/** エージェントへの注意書き（システムプロンプトに追記） */
export function workspaceNote(ws: Workspace, projectPath: string): string {
  return [
    '# 作業場所について',
    `あなたは元のプロジェクト（${projectPath}）から分離した作業用コピー（git worktree、ブランチ ${ws.branch}）で作業しています。作業フォルダは ${ws.path} です。`,
    '- 元のプロジェクトのフォルダのファイルは読み書きしない。ブランチを切り替えない。git push はしない',
    '- 依存パッケージ（node_modules など）は元のプロジェクトのものが共有されている。無ければインストールしてよい',
    '- .gitignore で除外されたファイル（.env など）はこのコピーには無い。必要なら報告の「判断が必要」に書く',
    '- 変更を元のプロジェクトへ反映するのは利用者が Tower の「取り込む」ボタンで行う。あなたがコミットする必要はない',
  ].join('\n');
}
