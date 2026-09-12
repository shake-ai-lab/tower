import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_LIMITS, clearDraft, draftIds, fileKey, fingerprint, loadDesk, loadWorkspace, readDraft, saveDesk, saveWorkspace, writeDraft, type Store } from './src/editor-persist';

class Memory implements Store {
  map = new Map<string, string>();
  full = false;
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.full) throw new Error('QuotaExceededError'); this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

test('開いていたタブ・分割・選んでいたタブを戻す', () => {
  const store = new Memory();
  const a = fileKey('s1', 'src/a.ts'), b = fileKey('s1', 'README.md');
  saveWorkspace({ tabs: [{ sessionId: 's1', path: 'src/a.ts', pane: 0 }, { sessionId: 's1', path: 'README.md', pane: 1 }], selected: [a, b], pane: 1, layout: 'columns', visible: true }, store);
  assert.deepEqual(loadWorkspace(store), { tabs: [{ sessionId: 's1', path: 'src/a.ts', pane: 0 }, { sessionId: 's1', path: 'README.md', pane: 1 }], selected: [a, b], pane: 1, layout: 'columns', visible: true });
});

test('壊れた・古い形の保存は無視し、食い違いは直して戻す', () => {
  const store = new Memory();
  assert.equal(loadWorkspace(store), null);
  store.setItem('tower.editor.workspace', '{壊れた');
  assert.equal(loadWorkspace(store), null);
  // 分割なしなのに右のグループにある・同じタブが 2 つ・選んでいたタブが無い
  store.setItem('tower.editor.workspace', JSON.stringify({ tabs: [{ sessionId: 's1', path: 'a', pane: 1 }, { sessionId: 's1', path: 'a', pane: 0 }, { sessionId: 's2', path: 'b', pane: 0 }, { path: 'x' }], selected: ['gone', null], pane: 1, layout: 'single', visible: true }));
  const ws = loadWorkspace(store)!;
  assert.deepEqual(ws.tabs, [{ sessionId: 's1', path: 'a', pane: 0 }, { sessionId: 's2', path: 'b', pane: 0 }]);
  assert.deepEqual(ws.selected, [fileKey('s2', 'b'), null]);
  assert.equal(ws.pane, 0);
  // タブが無ければ編集領域は出さない
  store.setItem('tower.editor.workspace', JSON.stringify({ tabs: [], selected: [], layout: 'nope', visible: true }));
  assert.deepEqual(loadWorkspace(store), { tabs: [], selected: [null, null], pane: 0, layout: 'single', visible: false });
});

test('自由配置の位置・倍率・分割の比率を戻し、範囲外は丸める', () => {
  const store = new Memory();
  const id = fileKey('s1', 'a.ts');
  saveDesk({ ratio: 95, zoom: 7, positions: { [id]: { x: -300, y: 20, w: 520, h: 440, angle: 15, z: 3, text: 9 }, bad: { x: 1 } as never }, restores: {}, center: { x: 12, y: -8 } }, store);
  const desk = loadDesk(store)!;
  assert.equal(desk.ratio, 80);
  assert.equal(desk.zoom, 2);
  assert.deepEqual(desk.positions, { [id]: { x: -300, y: 20, w: 520, h: 440, angle: 15, z: 3, text: 2.5 } });
  assert.deepEqual(desk.center, { x: 12, y: -8 });
});

test('書きかけは読み込んだ時の中身の指紋と一緒に残り、保存したら消せる', () => {
  const store = new Memory();
  const id = fileKey('s1', 'a.ts');
  assert.ok(writeDraft(id, 'const a = 1;\n', 'const a = 2;\n', store, 100));
  const d = readDraft(id, store)!;
  assert.equal(d.value, 'const a = 2;\n');
  assert.equal(d.base, fingerprint('const a = 1;\n'));
  assert.notEqual(d.base, fingerprint('const a = 3;\n'));
  assert.equal(d.at, 100);
  clearDraft(id, store);
  assert.equal(readDraft(id, store), null);
});

test('大きすぎる・入りきらない書きかけは古いものを残さず消す', () => {
  const store = new Memory();
  const id = fileKey('s1', 'big.txt');
  writeDraft(id, '', 'old', store);
  assert.equal(writeDraft(id, '', 'x'.repeat(DRAFT_LIMITS.chars + 1), store), false);
  assert.equal(readDraft(id, store), null);
  writeDraft(id, '', 'old', store);
  store.full = true;
  assert.equal(writeDraft(id, '', 'new', store), false);
  assert.equal(readDraft(id, store), null);
});

test('書きかけが上限を超えたら古いものから消す', () => {
  const store = new Memory();
  for (let i = 0; i <= DRAFT_LIMITS.files; i++) writeDraft(fileKey('s1', `f${i}`), '', `v${i}`, store, 1000 + i);
  const ids = draftIds(store);
  assert.equal(ids.length, DRAFT_LIMITS.files);
  assert.ok(!ids.includes(fileKey('s1', 'f0')));
  assert.ok(ids.includes(fileKey('s1', `f${DRAFT_LIMITS.files}`)));
});
