import fs from 'node:fs';
import path from 'node:path';
import type { ProjectInfo } from '@tower/shared';

export function browseProjects(directory: string): { path: string; parent: string | null; projects: ProjectInfo[] } {
  if (!path.isAbsolute(directory)) throw new Error('フォルダの絶対パスを入力してください');
  const current = fs.realpathSync(directory);
  const entries = fs.readdirSync(current, { withFileTypes: true });
  const projects = entries.filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules').flatMap((e) => {
    const full = path.join(current, e.name);
    try {
      const stat = fs.statSync(full);
      return stat.isDirectory() ? [{ path: full, name: e.name, hasGit: fs.existsSync(path.join(full, '.git')), modifiedAt: stat.mtimeMs }] : [];
    } catch { return []; }
  }).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return { path: current, parent: path.dirname(current) === current ? null : path.dirname(current), projects };
}
