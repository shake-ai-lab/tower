import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vscodeCodex } from './codex-bin.ts';

test('VS Code の Codex 拡張のうち、いちばん新しい版の本体を選ぶ（本体の無い版は飛ばす）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-codex-'));
  const exeName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const v of ['26.908.31748', '26.908.40401', '25.1.2']) {
    const dir = path.join(root, `openai.chatgpt-${v}-win32-x64`, 'bin', 'windows-x86_64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, exeName), '');
  }
  fs.mkdirSync(path.join(root, 'openai.chatgpt-27.0.0-win32-x64'));
  fs.mkdirSync(path.join(root, 'someone.else-9.9.9'));
  const r = vscodeCodex([root]);
  assert.equal(r?.version, '26.908.40401');
  assert.match(r?.exe ?? '', /26\.908\.40401/);
  assert.equal(vscodeCodex([path.join(root, 'nothing')]), null);
});
