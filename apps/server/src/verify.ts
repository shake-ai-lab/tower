// 自動チェック: エージェントの「テスト通りました」を鵜呑みにせず、プロジェクトのテストを Tower 側で実行して並べて見せる。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let enabled = true;
export function setVerifyEnabled(v: boolean) {
  enabled = v;
}

function readJson(file: string): Record<string, unknown> | null {
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
 * プロジェクトに合ったチェックコマンドを推定する。
 * .tower.json の "verify" があればそれを優先（null なら無効）。
 */
export function detectVerifyCommand(projectPath: string): string | null {
  if (!enabled) return null;
  const local = readJson(path.join(projectPath, '.tower.json'));
  if (local && 'verify' in local) return typeof local.verify === 'string' ? local.verify : null;

  const pkg = readJson(path.join(projectPath, 'package.json'));
  const test = (pkg?.scripts as Record<string, string> | undefined)?.test;
  if (test && !/no test specified/i.test(test)) return 'npm test';

  const pyproject = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(path.join(projectPath, 'pytest.ini'))) return 'python -m pytest -q';
  if (fs.existsSync(pyproject) && /pytest/.test(fs.readFileSync(pyproject, 'utf8'))) return 'python -m pytest -q';
  if (hasPyTests(projectPath)) return 'python -m unittest -q';
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
    // jest / vitest / pytest / cargo は最後の集計行に "N passed" "N failed" が並ぶ
    const line = lines.filter((l) => /\b\d+ (passed|failed)\b/.test(l)).at(-1);
    if (line) {
      const p = line.match(/(\d+) passed/);
      const f = line.match(/(\d+) failed/);
      pass = p ? Number(p[1]) : 0;
      fail = f ? Number(f[1]) : 0;
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
  if (pass === null || fail === null) return null;
  if (fail === 0) return pass > 0 ? `全部成功（${pass} 件）` : ok ? '成功' : '失敗';
  return `失敗 ${fail} 件${pass ? `・成功 ${pass} 件` : ''}`;
}

export function runVerify(
  projectPath: string,
  command: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; output: string; summary: string | null; durationMs: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks: string[] = [];
    const child = spawn(command, { cwd: projectPath, shell: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    const timer = setTimeout(() => {
      chunks.push(`\n(タイムアウト: ${timeoutMs / 1000}秒で打ち切り)`);
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.on('error', (e) => chunks.push(`\n(起動失敗: ${e.message})`));
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = chunks.join('').trim();
      const ok = code === 0;
      resolve({
        ok,
        output: output.length > 4000 ? `…${output.slice(-4000)}` : output,
        summary: summarizeTestOutput(output, ok),
        durationMs: Date.now() - t0,
      });
    });
  });
}
