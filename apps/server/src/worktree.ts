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

export function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    // メッセージを英語に固定して判定しやすくする。認証プロンプトで止まらないようにする
    env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
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

function commitAll(ws: Workspace, title: string): string | null {
  const status = git(ws.root, ['status', '--porcelain', '--untracked-files=all']).out;
  if (!status) return null;
  const add = git(ws.root, ['add', '-A']);
  if (!add.ok) return `変更を保存できませんでした: ${add.err}`;
  const msg = `Tower: ${title}`;
  let c = git(ws.root, ['commit', '-q', '-m', msg]);
  if (!c.ok && /tell me who you are|user\.name|user\.email/i.test(`${c.out}\n${c.err}`)) {
    c = git(ws.root, ['-c', 'user.name=Tower', '-c', 'user.email=tower@localhost', 'commit', '-q', '-m', msg]);
  }
  if (!c.ok) return `変更を保存（コミット）できませんでした: ${c.err || c.out}`;
  return null;
}

/**
 * 作業場所の変更を元のプロジェクトに取り込む。
 * 1. 作業場所の未保存の変更をコミット 2. 元のプロジェクトで今開いているブランチに merge
 */
export function mergeWorktree(projectPath: string, ws: Workspace, title: string): MergeResult {
  if (!fs.existsSync(ws.root)) {
    return { ok: false, message: '分離した作業場所のフォルダが見つかりません（消された可能性があります）', files: 0 };
  }
  const commitErr = commitAll(ws, title);
  if (commitErr) return { ok: false, message: commitErr, files: 0 };

  const target = currentBranch(projectPath);
  const targetLabel = target || '今の状態（ブランチなし）';
  const ahead = git(projectPath, ['rev-list', '--count', `HEAD..${ws.branch}`]);
  if (ahead.ok && ahead.out === '0') {
    return { ok: true, message: '取り込む変更はありません（すでに元のプロジェクトに入っています）', files: 0 };
  }
  const files = git(projectPath, ['diff', '--name-only', `HEAD...${ws.branch}`]).out.split(/\r?\n/).filter(Boolean);
  const m = git(projectPath, ['merge', '--no-edit', '-m', `Tower: ${title} を取り込み`, ws.branch]);
  if (m.ok) {
    return { ok: true, message: `元のプロジェクト（${targetLabel}）に ${files.length} ファイルの変更を取り込みました`, files: files.length };
  }
  const text = `${m.out}\n${m.err}`;
  if (/CONFLICT|Automatic merge failed/i.test(text)) {
    git(projectPath, ['merge', '--abort']);
    return {
      ok: false,
      message:
        `元のプロジェクトと同じ箇所が別々に変わっていて、自動では合流できません（競合）。` +
        `このセッションに「元のブランチ ${target || ws.baseBranch || '（元のコミット）'} の変更を取り込んで、競合を直して」と指示すると AI に直させられます。直ったらもう一度「取り込む」を押してください。`,
      files: 0,
    };
  }
  if (/local changes|would be overwritten|untracked working tree files/i.test(text)) {
    return {
      ok: false,
      message:
        '元のプロジェクト側に保存（コミット）していない変更があり、取り込む内容と重なっています。' +
        '先に元のプロジェクト側の変更を保存するか、元に戻してから、もう一度「取り込む」を押してください。\n' +
        text.slice(0, 600),
      files: 0,
    };
  }
  return { ok: false, message: `取り込みに失敗しました:\n${text.slice(0, 600)}`, files: 0 };
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
