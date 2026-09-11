// Tower の版。開発中はリポジトリの package.json から、束ねた（インストーラ）版は esbuild の define で埋め込まれる
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fromPackageJson(): string {
  try {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json');
    return (JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION: string = process.env.TOWER_VERSION || fromPackageJson();
