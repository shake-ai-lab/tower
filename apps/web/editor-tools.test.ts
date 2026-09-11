import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFile, rankFiles, resolveLink } from './src/editor-tools.ts';

const files = [
  'apps/web/src/components/EditorWorkspace.tsx',
  'apps/web/src/editor-workspace.ts',
  'docs/editor-workspace.md',
  'apps/server/src/index.ts',
  'apps/web/src/App.tsx',
];

test('quick open puts file-name hits first and accepts scattered letters and several words', () => {
  assert.equal(rankFiles(files, 'app')[0].path, 'apps/web/src/App.tsx');
  assert.deepEqual(matchFile('apps/web/src/App.tsx', 'app')?.hits, [13, 14, 15]);
  assert.equal(rankFiles(files, 'web app')[0].path, 'apps/web/src/App.tsx');
  assert.equal(rankFiles(files, 'server index')[0].path, 'apps/server/src/index.ts');
  assert.ok(rankFiles(files, 'edws').some((f) => f.path === 'apps/web/src/components/EditorWorkspace.tsx'));
  assert.equal(matchFile('apps/server/src/index.ts', 'zzz'), null);
  assert.equal(rankFiles(files, '').length, files.length);
  assert.equal(rankFiles(files, 'a', 2).length, 2);
});

test('document links resolve inside the project only', () => {
  assert.equal(resolveLink('docs/guide.md', './img/a.png'), 'docs/img/a.png');
  assert.equal(resolveLink('docs/guide.md', '../README.md#top'), 'README.md');
  assert.equal(resolveLink('docs/a.md', '/apps/x.ts'), 'apps/x.ts');
  assert.equal(resolveLink('docs/a.md', 'my%20file.md'), 'docs/my file.md');
  assert.equal(resolveLink('docs/guide.md', 'https://example.com'), null);
  assert.equal(resolveLink('docs/guide.md', 'mailto:a@example.com'), null);
  assert.equal(resolveLink('docs/guide.md', '#section'), null);
  assert.equal(resolveLink('guide.md', '../../etc/passwd'), null);
});
