import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codexAppServerArgs, codexAppServerEnv, codexAppServerLaunch } from './agents/codex-launch.ts';
import { windowsConsoleLauncher, validateConsoleBinary } from './agents/codex-windows-console.ts';

test('WindowsのCodexは起動時だけlogin shellを無効にする', () => {
  assert.deepEqual(codexAppServerArgs([], 'win32'), ['app-server', '-c', 'allow_login_shell=false']);
});

test('Node経由のCodexも空白を含むスクリプトパスを保持し、元の引数を変更しない', () => {
  const prefix = Object.freeze(['C:\\Program Files\\Codex\\bin\\codex.js']);
  assert.deepEqual(codexAppServerArgs(prefix, 'win32'), [prefix[0], 'app-server', '-c', 'allow_login_shell=false']);
  assert.deepEqual(prefix, ['C:\\Program Files\\Codex\\bin\\codex.js']);
});

test('Windows以外は従来のapp-server引数を維持する', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    assert.deepEqual(codexAppServerArgs([], platform), ['app-server']);
    assert.deepEqual(codexAppServerArgs(['/opt/codex/bin/codex.js'], platform), ['/opt/codex/bin/codex.js', 'app-server']);
  }
});

test('Windowsの未設定・空のPython標準入出力encodingだけをUTF-8に補完する', () => {
  for (const source of [{}, { PYTHONIOENCODING: undefined }, { PYTHONIOENCODING: '' }]) {
    const env = codexAppServerEnv(source, 'win32');
    assert.equal(env.PYTHONIOENCODING, 'utf-8');
    assert.equal(env.PYTHONUTF8, undefined);
  }
});

test('Pythonの明示encodingはWindowsの大文字小文字違いも含めて尊重する', () => {
  for (const key of ['PYTHONIOENCODING', 'PythonIoEncoding']) {
    const explicit = Object.freeze({ [key]: 'cp932:replace', PYTHONUTF8: '0' });
    const env = codexAppServerEnv(explicit, 'win32');
    assert.equal(env[key], 'cp932:replace');
    assert.equal(env.PYTHONUTF8, '0');
    assert.equal(Object.keys(env).filter((name) => name.toUpperCase() === 'PYTHONIOENCODING').length, 1);
    const empty = codexAppServerEnv({ [key]: '' }, 'win32');
    assert.equal(empty[key], 'utf-8');
  }
});

test('Codex用環境は親環境を変更せず、既存の起動マーカー処理を維持する', () => {
  const source = Object.freeze({ Path: 'C:\\tools', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', TOWER_MANAGED: '0', PYTHONIOENCODING: '' });
  const env = codexAppServerEnv(source, 'win32');
  assert.equal(source.CLAUDECODE, '1');
  assert.equal(source.CLAUDE_CODE_ENTRYPOINT, 'cli');
  assert.equal(source.TOWER_MANAGED, '0');
  assert.equal(source.PYTHONIOENCODING, '');
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.TOWER_MANAGED, '1');
  assert.equal(env.Path, source.Path);
});

test('Windows以外のPython環境変数は追加・変更しない', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    for (const source of [{}, { PYTHONIOENCODING: '' }, { PYTHONIOENCODING: 'latin-1' }]) {
      assert.deepEqual(codexAppServerEnv(source, platform), { ...source, TOWER_MANAGED: '1' });
    }
  }
});

test('Windows以外は専用コンソールを経由しない', () => {
  assert.deepEqual(codexAppServerLaunch('/bin/codex', ['original'], 'linux'), { command: '/bin/codex', args: ['original', 'app-server'] });
});

test('専用コンソールは引数・UTF-8標準入出力・終了コードを保持する', { skip: process.platform !== 'win32' }, () => {
  const args = ['', '空白 と 日本語', 'quote"inside', 'C:\\trailing space\\', '& | < > %PATH% !x! $(no)', '\\"'];
  const script = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(1),input}));process.stderr.write('エラー出力');process.exitCode=37})`;
  const result = spawnSync(windowsConsoleLauncher(), [process.execPath, '-e', script, '--', ...args], { input: '開始\n日本語確認😀\n終了', encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 37);
  assert.deepEqual(JSON.parse(result.stdout), { args, input: '開始\n日本語確認😀\n終了' });
  assert.equal(result.stderr, 'エラー出力');
});

test('専用コンソールでnative PowerShellの日本語出力をUTF-8で受け取る', { skip: process.platform !== 'win32' }, () => {
  const script = "$ProgressPreference='SilentlyContinue'; Write-Output '開始_日本語'; Write-Output '確認_漢字かなカナ😀'; Write-Output '終了_日本語'; exit 23";
  const result = spawnSync(windowsConsoleLauncher(), ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 23);
  assert.equal(result.stdout, '開始_日本語\r\n確認_漢字かなカナ😀\r\n終了_日本語\r\n');
  assert.equal(result.stderr, '');
});

test('専用コンソールは呼び出し元コンソールのコードページを変更しない', { skip: process.platform !== 'win32' }, () => {
  // The outer launcher owns this CP932 console; the user's terminal is untouched.
  const launcher = windowsConsoleLauncher();
  const script = `$ProgressPreference='SilentlyContinue'; Add-Type 'using System.Runtime.InteropServices; public class CodePage { [DllImport("kernel32.dll")] public static extern bool SetConsoleOutputCP(uint cp); [DllImport("kernel32.dll")] public static extern uint GetConsoleOutputCP(); }'; [CodePage]::SetConsoleOutputCP(932) | Out-Null; $before=[CodePage]::GetConsoleOutputCP(); & '${launcher.replace(/'/g, "''")}' '${process.execPath.replace(/'/g, "''")}' -e 'process.stdout.write(Buffer.from([99,104,105,108,100]))'; if($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; $after=[CodePage]::GetConsoleOutputCP(); Write-Output ":before=$before,after=$after"`;
  const result = spawnSync(launcher, ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'child:before=932,after=932\r\n');
});

test('ランチャー停止で起動した子・孫プロセスも停止する', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000)`;
  const proc = spawn(windowsConsoleLauncher(), [process.execPath, '-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let pids: number[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const data = await Promise.race([once(proc.stdout, 'data'), once(proc, 'error').then(([error]) => { throw error; })]);
    const result = JSON.parse(String(data[0]));
    pids = [result.parent, result.child];
    assert.ok(pids.every(alive));
    const closed = once(proc, 'close');
    proc.kill();
    await closed;
    for (let i = 0; i < 100 && pids.some(alive); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(pids.every((pid) => !alive(pid)), 'owned child tree must exit when the launcher is stopped');
  } finally {
    proc.kill();
    for (const pid of pids) { try { process.kill(pid); } catch { /* already stopped */ } }
  }
});

test('ランチャーはTEMP外で生成し、生成後の改ざんと設定sidecarを起動前に拒否する', { skip: process.platform !== 'win32' }, () => {
  const launcher = windowsConsoleLauncher();
  assert.ok(launcher.toLowerCase().startsWith(path.resolve(process.env.LOCALAPPDATA!, 'Tower', 'runtime', 'codex-console').toLowerCase() + path.sep));
  assert.ok(!launcher.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep));
  const original = fs.readFileSync(launcher);
  try {
    fs.appendFileSync(launcher, 'tampered');
    assert.throws(() => windowsConsoleLauncher(), /integrity/);
  } finally { fs.writeFileSync(launcher, original); }
  const sidecar = launcher + '.config';
  try {
    fs.writeFileSync(sidecar, '<configuration/>', { flag: 'wx' });
    assert.throws(() => windowsConsoleLauncher(), /unexpected file/);
  } finally { fs.unlinkSync(sidecar); }
  assert.equal(windowsConsoleLauncher(), launcher);
});

test('生成物検証は祖先junctionとhardlinkを拒否する', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-launch-integrity-'));
  const target = path.join(directory, 'target');
  const link = path.join(directory, 'linked');
  fs.mkdirSync(target);
  const file = path.join(target, 'console.exe');
  fs.writeFileSync(file, 'own-fixture');
  const hash = createHash('sha256').update('own-fixture').digest('hex');
  try {
    validateConsoleBinary(file, hash);
    fs.symlinkSync(target, link, 'junction');
    assert.throws(() => validateConsoleBinary(path.join(link, 'console.exe'), hash), /linked paths/);
    fs.linkSync(file, path.join(directory, 'hardlink.exe'));
    assert.throws(() => validateConsoleBinary(file, hash), /unexpected file or link/);
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('起動直後の強制停止でも生成途中の専用コンソールを残さない', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const launcher = windowsConsoleLauncher();
  const script = 'setInterval(()=>{},1000)';
  for (const milliseconds of [0, 1, 2, 5, 10, 15, 20, 30, 40, 60, 80, 100]) {
    const proc = spawn(launcher, [process.execPath, '-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const exited = once(proc, 'exit');
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    proc.kill();
    await exited;
    proc.stdout.destroy(); proc.stderr.destroy(); proc.stdin.destroy();
  }
  // The launcher path is a fresh, process-owned compilation, never a shared app binary.
  const ps = `@(Get-CimInstance Win32_Process -Filter "Name='console.exe'" | Where-Object { $_.ExecutablePath -eq '${launcher.replace(/'/g, "''")}' } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const survivors = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  try { assert.deepEqual(survivors, [], 'no unowned console child may survive a kill during startup'); }
  finally {
    for (const pid of Array.isArray(survivors) ? survivors : [survivors]) {
      if (Number.isInteger(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  }
});
