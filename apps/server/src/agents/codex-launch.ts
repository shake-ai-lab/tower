import { windowsConsoleLauncher } from './codex-windows-console.ts';

/** WindowsではPowerShellプロファイルを読み込まず、サンドボックスとの衝突を避ける。
 * CLI overrideなので利用者のCodex設定ファイルには保存しない。
 */
export function codexAppServerArgs(prefix: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return [...prefix, 'app-server', ...(platform === 'win32' ? ['-c', 'allow_login_shell=false'] : [])];
}

export function codexAppServerEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, TOWER_MANAGED: '1' };
  // TowerがClaude Codeの中から起動されていても、その印はCodexに渡さない。
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (platform === 'win32') {
    // Pythonの標準入出力をCodexのUTF-8受信に合わせる。ファイルの既定encodingは変更しない。
    // Windowsの環境変数名は大文字小文字を区別しないため、既存キーを使う。
    const key = Object.keys(env).find((name) => name.toUpperCase() === 'PYTHONIOENCODING') ?? 'PYTHONIOENCODING';
    if (!env[key]) env[key] = 'utf-8';
  }
  return env;
}
/** Keep shell parsing out of the launch path, including spaces and quote characters. */
export function codexAppServerLaunch(command: string, prefix: readonly string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const args = codexAppServerArgs(prefix, platform);
  return platform === 'win32'
    ? { command: windowsConsoleLauncher(), args: [command, ...args] }
    : { command, args };
}
