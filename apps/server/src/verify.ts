// 自動チェック: エージェントの「テスト通りました」を鵜呑みにせず、プロジェクトのテストを Tower 側で実行して並べて見せる。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let enabled = true;
export function setVerifyEnabled(v: boolean) {
  enabled = v;
}

export function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasPyTests(dir: string): boolean {
  const cands = [dir, path.join(dir, 'tests'), path.join(dir, 'test')];
  for (const d of cands) {
    try {
      if (fs.readdirSync(d).some((f) => /^test_.*\.py$|_test\.py$/.test(f))) return true;
    } catch {
      /* no dir */
    }
  }
  return false;
}

/**
 * プロジェクト専用の Python（.venv / venv）。無ければ null（PATH の python を使う）。
 * PATH の python が古いと、エージェントは専用の Python で「全部成功」、Tower は毎回「失敗」と食い違っていた。
 * 別の作業場所（git worktree）には .venv が写らない（.gitignore）ので、元のプロジェクトのものも探す
 */
export function projectPython(projectPath: string, originalPath?: string): string | null {
  const rel = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  for (const root of [projectPath, originalPath]) {
    if (!root) continue;
    for (const env of ['.venv', 'venv']) {
      const p = path.join(root, env, ...rel);
      if (!fs.existsSync(p)) continue;
      // 作業フォルダの中なら短く書く（画面に出るので）。外なら空白があっても動くよう括る
      return root === projectPath ? path.join(env, ...rel) : `"${p}"`;
    }
  }
  return null;
}

/**
 * プロジェクトに合ったチェックコマンドを推定する。
 * .tower.json の "verify" があればそれを優先（null なら無効）。
 * originalPath = 別の作業場所で動かしている時の元のプロジェクト（専用の Python を探す）
 */
export function detectVerifyCommand(projectPath: string, originalPath?: string): string | null {
  if (!enabled) return null;
  const local = readJson(path.join(projectPath, '.tower.json'));
  if (local && 'verify' in local) return typeof local.verify === 'string' ? local.verify : null;

  const pkg = readJson(path.join(projectPath, 'package.json'));
  const test = (pkg?.scripts as Record<string, string> | undefined)?.test;
  if (test && !/no test specified/i.test(test)) return 'npm test';

  const py = () => projectPython(projectPath, originalPath) ?? 'python';
  const pyproject = path.join(projectPath, 'pyproject.toml');
  // -q は付けない。プロジェクトの設定（addopts）にも -q があると二重になり、pytest が最後の件数の行を出さなくなる
  if (fs.existsSync(path.join(projectPath, 'pytest.ini'))) return `${py()} -m pytest`;
  if (fs.existsSync(pyproject) && /pytest/.test(fs.readFileSync(pyproject, 'utf8'))) return `${py()} -m pytest`;
  if (hasPyTests(projectPath)) return `${py()} -m unittest -q`;
  if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) return 'cargo test';
  if (fs.existsSync(path.join(projectPath, 'go.mod'))) return 'go test ./...';
  return null;
}

/**
 * テスト出力から件数を拾って日本語にする（分かる範囲で）。
 * node:test（# pass / # fail）、jest / vitest / pytest / mocha / cargo（"N passed" "N failed" の行）に対応。拾えなければ null
 */
export function summarizeTestOutput(output: string, ok: boolean): string | null {
  let pass: number | null = null;
  let fail: number | null = null;
  const tapPass = output.match(/^# pass (\d+)/m);
  const tapFail = output.match(/^# fail (\d+)/m);
  if (tapPass || tapFail) {
    pass = tapPass ? Number(tapPass[1]) : 0;
    fail = tapFail ? Number(tapFail[1]) : 0;
  } else {
    const lines = output.split(/\r?\n/);
    // jest / vitest / pytest / cargo は最後の集計行に "N passed" "N failed" が並ぶ。
    // pytest は読み込めなかったファイルを "N errors in 1.2s" と数える（テストが 1 件も走らないとこれだけになる）
    const line = lines.filter((l) => /\b\d+ (passed|failed)\b|\b\d+ errors? in [\d.]+s\b/.test(l)).at(-1);
    if (line) {
      const p = line.match(/(\d+) passed/);
      const f = line.match(/(\d+) failed/);
      const e = line.match(/(\d+) errors? in /);
      pass = p ? Number(p[1]) : 0;
      fail = (f ? Number(f[1]) : 0) + (e ? Number(e[1]) : 0);
    } else {
      // mocha は "N passing" と "N failing" が別の行
      const last = (re: RegExp) => lines.map((l) => l.match(re)).filter(Boolean).at(-1);
      const p = last(/(\d+) passing/);
      const f = last(/(\d+) failing/);
      if (p || f) {
        pass = p ? Number(p[1]) : 0;
        fail = f ? Number(f[1]) : 0;
      }
    }
  }
  if (pass === null || fail === null) {
    // 件数の行が無い（pytest を -qq で走らせた時など）: 失敗したテストの名前の行だけでも数える
    const failed = ok ? 0 : failedTests(output).length;
    return failed ? `失敗 ${failed} 件（全体の件数は出ていません）` : null;
  }
  if (fail === 0) return pass > 0 ? `全部成功（${pass} 件）` : ok ? '成功' : '失敗';
  return `失敗 ${fail} 件${pass ? `・成功 ${pass} 件` : ''}`;
}

// 失敗したテストの名前を拾うパターン（ランナーごと）。files = ファイル単位の行も拾う
const FAIL_PATTERNS: { re: RegExp; files?: boolean }[] = [
  { re: /^\s*not ok \d+ - (.+?)\s*$/gm }, // node:test（TAP）。ファイルごとにも not ok を出すので、それは除く
  { re: /^\s*[✕×✗] (.+?)(?: \(\d+ ?ms\))?\s*$/gm }, // jest / vitest
  { re: /^FAILED (\S+?)(?: - .*)?$/gm }, // pytest
  { re: /^ERROR (\S+?)(?: - .*)?$/gm, files: true }, // pytest（読み込めなかったファイル）
  { re: /^\s*\d+\) (.+?)\s*$/gm }, // mocha
  { re: /^test (\S+) \.\.\. FAILED$/gm }, // cargo
  { re: /^--- FAIL: (\S+)/gm }, // go
];

/** 失敗したテスト名（最大 20 件）。「修正前から落ちていた」と「新しく壊れた」を見分けるのに使う */
export function failedTests(output: string): string[] {
  const out = new Set<string>();
  for (const { re, files } of FAIL_PATTERNS) {
    for (const m of output.matchAll(re)) {
      const name = m[1].trim();
      if (!name || (!files && /\.(m?[jt]s|py)$/.test(name))) continue;
      out.add(name);
      if (out.size >= 20) return [...out];
    }
  }
  return [...out];
}

// 色付けの記号。pytest は FORCE_COLOR があると値が 0 でも色を付けるので、件数や名前が拾えなくなっていた
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export interface VerifyResult {
  ok: boolean;
  cancelled: boolean;
  timedOut: boolean;
  output: string;
  summary: string | null;
  failed: string[];
  durationMs: number;
}

export function runVerify(
  projectPath: string,
  command: string,
  // 専用の Python で本物のテストを走らせると 100 秒を超えるプロジェクトもある（2 分で切ると毎回「失敗」になる）
  timeoutMs = 300_000,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    if (signal?.aborted) {
      resolve({ ok: false, cancelled: true, timedOut: false, output: '(検証を中止しました)', summary: '中止', failed: [], durationMs: 0 });
      return;
    }
    const chunks: string[] = [];
    const child = spawn(command, {
      cwd: projectPath,
      shell: true,
      // shell 越しに起動するので、止める時は子孫ごと（Windows は taskkill /T、他は プロセスグループ）
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', PY_COLORS: '0' },
    });
    const killTree = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killed = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore', windowsHide: true, timeout: 10_000,
        });
        if (killed.error || killed.status !== 0) child.kill('SIGKILL');
      }
      else {
        // SIGTERM を無視するテスト/子プロセスも、停止後に残さない。
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let forced: NodeJS.Timeout | null = null;
    const interrupt = (reason: 'cancel' | 'timeout') => {
      if (settled || cancelled || timedOut) return;
      cancelled = reason === 'cancel';
      timedOut = reason === 'timeout';
      chunks.push(cancelled ? '\n(検証を中止しました)' : `\n(タイムアウト: ${timeoutMs / 1000}秒で打ち切り)`);
      // close が届かない場合も、待機と pipe の参照を残さない。
      forced = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null);
      }, 5000);
      killTree();
    };
    const abort = () => interrupt('cancel');
    const timer = setTimeout(() => interrupt('timeout'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.on('error', (e) => chunks.push(`\n(起動失敗: ${e.message})`));
    child.on('close', (code) => finish(code));
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forced) clearTimeout(forced);
      signal?.removeEventListener('abort', abort);
      const output = chunks.join('').replace(ANSI, '').trim();
      const ok = code === 0 && !cancelled && !timedOut;
      resolve({
        ok,
        cancelled,
        timedOut,
        output: output.length > 4000 ? `…${output.slice(-4000)}` : output,
        summary: cancelled ? '中止' : timedOut ? 'タイムアウト' : summarizeTestOutput(output, ok),
        failed: ok ? [] : failedTests(output),
        durationMs: Date.now() - t0,
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
