import test from 'node:test';
import assert from 'node:assert/strict';
import { describeActivity, describeCommand, describePermission, hasJapanese } from './humanize.ts';

test('hasJapanese: ひらがな・カタカナ・漢字のどれかがあれば真', () => {
  assert.equal(hasJapanese('テストを実行'), true);
  assert.equal(hasJapanese('ビルドしています'), true);
  assert.equal(hasJapanese('差分'), true);
  assert.equal(hasJapanese('Run the test suite'), false);
  assert.equal(hasJapanese('npm test'), false);
  assert.equal(hasJapanese(''), false);
  assert.equal(hasJapanese('（Ｒｕｎ）'), false); // 全角の記号・英字だけでは日本語扱いしない
  assert.equal(hasJapanese('Run テスト'), true); // 一部でも日本語があれば真
});

test('describeActivity: 日本語の description はそのまま（Tower 自身のタスクの表示は変わらない）', () => {
  const out = describeActivity('Bash', { command: 'npm test', description: 'テストを実行します' });
  assert.equal(out, 'テストを実行します');
  const long = 'あ'.repeat(80);
  assert.equal(describeActivity('PowerShell', { command: 'ls', description: long }), 'あ'.repeat(60) + '…');
});

test('describeActivity: 英語の description は使わず、コマンドから日本語を作る', () => {
  assert.equal(
    describeActivity('Bash', { command: 'npm test', description: 'Run the test suite' }),
    'テストを実行しています（npm test）',
  );
  assert.equal(
    describeActivity('PowerShell', { command: 'Get-ChildItem src', description: 'List source files' }),
    'ファイルの一覧を見ています（Get-ChildItem src）',
  );
});

test('describeActivity: description が無くてもコマンドから日本語になる', () => {
  assert.equal(describeActivity('Bash', { command: 'git status --short' }), 'git の状態を見ています（git status --short）');
  assert.equal(describeActivity('Bash', {}), 'コマンドを実行しています');
});

test('describeCommand: cd を飛ばして主役のコマンドを見る', () => {
  assert.equal(describeCommand('cd apps/web && npm run build'), 'ビルドしています（cd apps/web && npm run build）');
  assert.equal(describeCommand('cd /c/x; git diff HEAD~1'), '差分を見ています（cd /c/x; git diff HEAD~1）');
  assert.equal(describeCommand('cat package.json | head -20'), 'ファイルの中身を見ています（cat package.json | head -20）');
});

test('describeCommand: 代表的なコマンドの対応', () => {
  const cases: Array<[string, string]> = [
    ['git status --short', 'git の状態を見ています'],
    ['git log --oneline -5', '履歴を見ています'],
    ['git show HEAD', '変更内容を見ています'],
    ['git branch -a', 'ブランチを見ています'],
    ['git add -A', '変更を記録（コミット）しています'],
    ['git commit -m "fix"', '変更を記録（コミット）しています'],
    ['git push origin main', '変更を送信（push）しています'],
    ['git pull', '最新の変更を取り込んでいます'],
    ['git fetch --all', '最新の変更を取り込んでいます'],
    ['git checkout -b feat', 'ブランチを切り替え・統合しています'],
    ['git stash', 'ブランチを切り替え・統合しています'],
    ['git worktree add ../x', '作業場所を整えています'],
    ['git rev-parse HEAD', 'git を操作しています'],
    ['npm test', 'テストを実行しています'],
    ['npm run test:unit -- --watch', 'テストを実行しています'],
    ['yarn test', 'テストを実行しています'],
    ['npx vitest run', 'テストを実行しています'],
    ['npx playwright test', 'テストを実行しています'],
    ['pytest tests/', 'テストを実行しています'],
    ['cargo test', 'テストを実行しています'],
    ['go test ./...', 'テストを実行しています'],
    ['node --test src/', 'テストを実行しています'],
    ['npx tsx --test apps/server/src/humanize.test.ts', 'テストを実行しています'],
    ['npm run build -w apps/web', 'ビルドしています'],
    ['pnpm run compile', 'ビルドしています'],
    ['npx tsc -p tsconfig.json', 'ビルドしています'],
    ['npx tsc --noEmit', 'コードを点検しています'],
    ['vite build', 'ビルドしています'],
    ['cargo build --release', 'ビルドしています'],
    ['go build ./...', 'ビルドしています'],
    ['npm run typecheck', 'コードを点検しています'],
    ['npm run lint', 'コードを点検しています'],
    ['npx eslint .', 'コードを点検しています'],
    ['ruff check .', 'コードを点検しています'],
    ['npm install', 'パッケージを入れています'],
    ['npm i zod', 'パッケージを入れています'],
    ['pnpm add -D vitest', 'パッケージを入れています'],
    ['pip install requests', 'パッケージを入れています'],
    ['cargo add serde', 'パッケージを入れています'],
    ['npm run dev', 'dev を実行しています'],
    ['npm run dogfood -- --only todo-fix', 'dogfood を実行しています'],
    ['ls -la', 'ファイルの一覧を見ています'],
    ['find . -name "*.ts"', 'ファイルの一覧を見ています'],
    ['Get-ChildItem -Recurse', 'ファイルの一覧を見ています'],
    ['cat README.md', 'ファイルの中身を見ています'],
    ['head -n 20 a.txt', 'ファイルの中身を見ています'],
    ['sed -n 1,40p a.ts', 'ファイルの中身を見ています'],
    ['Get-Content a.txt', 'ファイルの中身を見ています'],
    ['wc -l a.txt', 'ファイルの中身を見ています'],
    ['grep -rn "foo" src', 'コードを検索しています'],
    ['rg foo', 'コードを検索しています'],
    ['Select-String -Path a.txt -Pattern x', 'コードを検索しています'],
    ['curl -s https://example.com', 'Web に接続しています'],
    ['Invoke-WebRequest https://example.com', 'Web に接続しています'],
    ['mkdir -p out', 'ファイルを整理しています'],
    ['cp a b', 'ファイルを整理しています'],
    ['mv a b', 'ファイルを整理しています'],
    ['New-Item -ItemType Directory x', 'ファイルを整理しています'],
    ['rm -rf dist', 'ファイルを消しています'],
    ['Remove-Item -Recurse dist', 'ファイルを消しています'],
    ['taskkill /F /IM Tower.exe', 'プロセスを止めています'],
    ['kill -9 1234', 'プロセスを止めています'],
    ['Stop-Process -Name node', 'プロセスを止めています'],
    ['node scripts/x.js', 'スクリプトを実行しています'],
    ['python3 main.py', 'スクリプトを実行しています'],
    ['npx tsx apps/server/src/index.ts', 'スクリプトを実行しています'],
    ['/usr/bin/python3 main.py', 'スクリプトを実行しています'],
    ['docker compose up -d', 'Docker を操作しています'],
    ['echo hello', '表示を確認しています'],
    ['Write-Output hi', '表示を確認しています'],
    ['FOO=1 npm test', 'テストを実行しています'],
    ['some-unknown-tool --flag', 'コマンドを実行しています'],
  ];
  for (const [cmd, expected] of cases) {
    const out = describeCommand(cmd);
    assert.ok(out.startsWith(expected + '（'), `${cmd} → ${out}（期待: ${expected}）`);
  }
});

test('describeCommand: 括弧の中はコマンドの先頭 40 文字、改行は空白に', () => {
  const cmd = 'npm test -- --reporter=verbose --coverage --watchAll=false\nsecond line';
  const out = describeCommand(cmd);
  assert.equal(out, `テストを実行しています（${'npm test -- --reporter=verbose --coverage --watchAll=false second line'.slice(0, 40)}…）`);
  assert.equal(describeCommand(''), 'コマンドを実行しています');
});

test('describePermission: 英語 description でも見出しは日本語、詳細はコマンド全文', () => {
  const cmd = 'cd apps/web && npm run build';
  const r = describePermission('Bash', { command: cmd, description: 'Build the web app' });
  assert.equal(r.headline, `ビルドしたい（${cmd}）`);
  assert.equal(r.detail, cmd);
  assert.equal(hasJapanese(r.headline), true);
});

test('describePermission: 日本語の description はそのまま見出しに', () => {
  const r = describePermission('PowerShell', { command: 'npm test', description: 'テストを走らせます' });
  assert.equal(r.headline, 'コマンドを実行したい: テストを走らせます');
  assert.equal(r.detail, 'npm test');
});

test('describeActivity: サブエージェントの英語 description も日本語になる', () => {
  assert.equal(describeActivity('Task', { description: '設定を調べる' }), 'サブエージェント: 設定を調べる');
  assert.equal(
    describeActivity('Agent', { description: 'Explore the config files' }),
    'サブエージェントを動かしています（Explore the config files）',
  );
  assert.equal(describeActivity('Task', {}), 'サブエージェントを動かしています');
});

test('describeCommand: 書き込み・削除を伴う形は「見ています」と言わない', () => {
  assert.match(describeCommand("cat > apps/x.ts <<'EOF'\nabc\nEOF"), /^ファイルに書き込んでいます（/);
  assert.match(describeCommand('echo "x" >> ~/.bashrc'), /^ファイルに書き込んでいます（/);
  assert.match(describeCommand('find . -name "*.tmp" -exec rm {} \;'), /^コマンドを実行しています（/);
  assert.match(describeCommand('ls | xargs rm -rf'), /^コマンドを実行しています（/);
  // 画面に出さないだけのリダイレクトは書き込みではない
  assert.match(describeCommand('npm test > /dev/null 2>&1'), /^テストを実行しています（/);
  assert.match(describeCommand('git status 2>&1'), /^git の状態を見ています（/);
});

test('describeCommand: run のオプションを動作名にしない、Set-Content は主役として残す、制御文字は空白に', () => {
  assert.match(describeCommand('npm run -w apps/web build'), /^ビルドしています（/);
  assert.match(describeCommand('npm run -w apps/web check'), /^check を実行しています（/);
  assert.match(describeCommand('Set-Content -Path a.txt -Value x'), /^コマンドを実行しています（Set-Content/);
  const esc = String.fromCharCode(27);
  assert.equal(describeCommand(`git status${esc}[0m`).includes(esc), false);
});
