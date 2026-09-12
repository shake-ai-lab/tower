import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPreview } from './preview.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tower-preview-'));

test('普通の index.html はそのまま配って撮る', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'index.html'), '<h1>hi</h1><script src="src/app.js"></script>');
  assert.deepEqual(detectPreview(d), { kind: 'static', dir: d });
});

test('Vite の開発用の入口は、組み立て前なら撮らず、dist があればそれを撮る', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'index.html'), '<div id="root"></div><script type="module" src="/src/main.tsx"></script>');
  assert.equal(detectPreview(d), null, '真っ白な写真を見せない');
  fs.mkdirSync(path.join(d, 'dist'));
  fs.writeFileSync(path.join(d, 'dist', 'index.html'), '<div id="root"></div><script type="module" src="/assets/index.js"></script>');
  assert.deepEqual(detectPreview(d), { kind: 'static', dir: path.join(d, 'dist') });
});

test('Vite の開発用の入口で vite が入っていれば、開発サーバーを立てて撮る', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'index.html'), '<script src="/src/main.ts" type="module"></script>');
  fs.mkdirSync(path.join(d, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite'), '');
  const t = detectPreview(d);
  assert.equal(t?.kind, 'url');
  assert.match(t?.kind === 'url' ? (t.command ?? '') : '', /--strictPort/);
});
