import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { CODEX_MISSING, findCodexBin } from './codex-bin.ts';
export interface LoginState { status: 'idle' | 'waiting' | 'success' | 'error'; url?: string; message?: string }
let state: LoginState = { status: 'idle' };
let child: ChildProcess | null = null;
function stopChild(proc: ChildProcess) {
  if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  else proc.kill();
}
process.once('exit', () => { if (child) stopChild(child); });
export const codexLoginState = () => ({ ...state });

/** Only expose the official authorization URL; never return CLI logs or credentials. */
export function authorizationUrl(output: string): string | undefined {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  for (const match of clean.matchAll(/https:\/\/[^\s<>"']+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.origin === 'https://auth.openai.com' && url.pathname === '/oauth/authorize') return url.href;
    } catch { /* incomplete output */ }
  }
}

export function startCodexLogin(): LoginState {
  if (child) return codexLoginState();
  // 本体は VS Code の Codex 拡張のもの（ログインは ~/.codex を VS Code と共有）
  const bin = findCodexBin();
  if (!bin) throw new Error(CODEX_MISSING);
  state = { status: 'waiting' };
  const proc = spawn(bin.command, [...bin.args, 'login'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child = proc;
  let output = '';
  const timer = setTimeout(() => {
    state = { status: 'error', message: 'ログインの待ち時間を超えました。もう一度お試しください。' };
    stopChild(proc);
  }, 5 * 60_000);
  timer.unref();
  const read = (data: Buffer) => {
    output = (output + data.toString()).slice(-16_384);
    const url = authorizationUrl(output);
    if (url && state.status === 'waiting') state = { status: 'waiting', url };
  };
  proc.stdout?.on('data', read); proc.stderr?.on('data', read);
  proc.on('error', () => { state = { status: 'error', message: 'Codexを起動できませんでした。Towerを再起動してお試しください。' }; });
  proc.on('close', (code) => {
    clearTimeout(timer); child = null; output = '';
    if (state.status !== 'error') state = code === 0 ? { status: 'success' } : { status: 'error', message: 'ログインが完了しませんでした。再試行するか、公式のログイン手順を確認してください。' };
  });
  return codexLoginState();
}
