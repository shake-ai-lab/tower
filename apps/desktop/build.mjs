// デスクトップ版のインストーラ（Windows: Tower-Setup-<version>.exe）を作る。
//   node apps/desktop/build.mjs            画面のビルドから全部
//   node apps/desktop/build.mjs --skip-web 画面はビルド済みのものを使う
//   node apps/desktop/build.mjs --dir      インストーラは作らず、展開した実行ファイルだけ（動作確認用）
//
// 手順:
//   1. 画面をビルド（apps/web/dist）
//   2. サーバーを esbuild で 1 ファイルに束ねる（stage/app/server.mjs）。子プロセスを起動する SDK 類は束ねずに npm で入れる
//   3. stage/ に必要なものだけ集めて npm install（monorepo の node_modules を丸ごと入れない）
//   4. electron-builder で NSIS インストーラ。Electron 本体は手元の node_modules/electron/dist を使う（ダウンロード無し）
//
// 入れた先の PC には Node.js（22.13 以上）が必要（サーバーと Claude Code の CLI を node で動かす）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const STAGE = path.join(HERE, 'stage');
const OUT = path.join(HERE, 'dist');
const args = new Set(process.argv.slice(2));
const run = (cmd, cwd = ROOT) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
};

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 1. 画面
if (!args.has('--skip-web')) run('npm run build -w apps/web');

// 2. サーバーを束ねる（前回の出来上がりも消す。Tower.exe が起動したままだと消せないので先に終了しておく）
fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'app', 'hooks'), { recursive: true });
await build({
  entryPoints: [path.join(ROOT, 'apps/server/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(STAGE, 'app', 'server.mjs'),
  // 子プロセス（Claude Code の CLI、ブラウザ）を自分の置き場所から探すものは束ねない
  external: ['@anthropic-ai/claude-agent-sdk', 'playwright-core'],
  // Codex の本体（378MB の @openai/codex）は入れず、VS Code の Codex 拡張のものを app-server として動かす（codex-bin.ts / agents/codex.ts）
  // 束ねると package.json が隣に無いので、版はここで埋め込む（「気づいたこと」の場面に記す）
  define: { 'process.env.TOWER_VERSION': JSON.stringify(rootPkg.version) },
  // 束ねた CommonJS 側の require() が ESM の中でも動くように、本物の require を用意する
  banner: {
    js: "import { createRequire as __towerCreateRequire } from 'node:module'; globalThis.require = __towerCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// 3. 必要なものだけ集める
fs.copyFileSync(path.join(ROOT, 'apps/server/hooks/tower-hook.mjs'), path.join(STAGE, 'app', 'hooks', 'tower-hook.mjs'));
fs.cpSync(path.join(ROOT, 'apps/web/dist'), path.join(STAGE, 'web'), { recursive: true });
fs.copyFileSync(path.join(HERE, 'main.cjs'), path.join(STAGE, 'main.cjs'));
fs.copyFileSync(path.join(HERE, 'icon.png'), path.join(STAGE, 'icon.png'));

const serverPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/server/package.json'), 'utf8'));
const electronVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/electron/package.json'), 'utf8')).version;
const runtimeDeps = ['@anthropic-ai/claude-agent-sdk', 'playwright-core', 'ws'];
fs.writeFileSync(
  path.join(STAGE, 'package.json'),
  JSON.stringify(
    {
      name: 'tower',
      productName: 'Tower',
      version: rootPkg.version,
      description: 'AIエージェント管制塔',
      private: true,
      main: 'main.cjs',
      dependencies: Object.fromEntries(runtimeDeps.map((n) => [n, serverPkg.dependencies[n]])),
      devDependencies: { electron: electronVersion },
      build: {
        appId: 'jp.shakeailab.tower',
        productName: 'Tower',
        electronVersion,
        electronDist: path.join(ROOT, 'node_modules/electron/dist'),
        // node で server.mjs を起動するので、asar に固めない
        asar: false,
        directories: { output: OUT },
        win: { target: ['nsis'], icon: 'icon.png', signAndEditExecutable: false },
        nsis: {
          oneClick: true,
          perMachine: false,
          createDesktopShortcut: true,
          shortcutName: 'Tower',
          artifactName: 'Tower-Setup-${version}.exe',
        },
      },
    },
    null,
    2,
  ),
);
run('npm install --omit=dev --no-package-lock --ignore-scripts --no-audit --no-fund', STAGE);

// 4. インストーラ
const builder = path.join(ROOT, 'node_modules/electron-builder/cli.js');
run(`node "${builder}" --win ${args.has('--dir') ? '--dir' : ''} --projectDir "${STAGE}"`);
console.log(`\n出来上がり: ${OUT}`);
