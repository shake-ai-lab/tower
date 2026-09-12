import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLayout, loadLayout, loadSlots, planOpen, slotFor, touch } from './src/layout.ts';

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const alive = (ids: string[]) => (id: string) => ids.includes(id);
const base = { chat: false, slots: ['a', 'b', 'c', 'd'], focusId: null, activeSlot: 0, recent: [0, 1, 2, 3] };

test('layout is restored, and the old single "view" setting is carried over', () => {
  assert.deepEqual(loadLayout(mem()), { sidebar: true, main: 'cards', chat: true });
  assert.deepEqual(loadLayout(mem({ 'tower.layout': JSON.stringify({ sidebar: false, main: 'quad', chat: true }) })), { sidebar: false, main: 'quad', chat: true });
  assert.deepEqual(loadLayout(mem({ 'tower.view': 'editor' })), { sidebar: true, main: 'files', chat: true });
  assert.deepEqual(loadLayout(mem({ 'tower.view': 'quad' })), { sidebar: true, main: 'quad', chat: false });
  assert.deepEqual(loadLayout(mem({ 'tower.layout': '{broken' })), { sidebar: true, main: 'cards', chat: true });
  assert.deepEqual(loadLayout(mem({ 'tower.layout': JSON.stringify({ main: 'nothing' }), 'tower.view': 'compact' })), { sidebar: true, main: 'compact', chat: true });
  assert.equal(loadLayout(null).main, 'cards');
});

test('quad panes are restored only when the saved value is well formed', () => {
  assert.deepEqual(loadSlots(mem({ 'tower.quad-slots': JSON.stringify(['a', null, 'b', null]) })), ['a', null, 'b', null]);
  assert.equal(loadSlots(mem({ 'tower.quad-slots': JSON.stringify(['a']) })), null);
  assert.equal(loadSlots(mem()), null);
});

test('the layout is described in plain words', () => {
  assert.equal(describeLayout({ sidebar: true, main: 'cards', chat: true }, 'single'), '左の欄 ＋ カード ＋ チャット');
  assert.equal(describeLayout({ sidebar: false, main: 'files', chat: true }, 'desk'), '自由配置 ＋ チャット');
  assert.equal(describeLayout({ sidebar: true, main: 'files', chat: false }, 'columns'), '左の欄 ＋ 開いたファイル');
});

test('a task goes to the pane already showing it, then an empty pane, then the least recently used one', () => {
  assert.equal(slotFor(['a', 'b', null, 'd'], 'b', [0, 1, 2, 3], alive(['a', 'b', 'd'])), 1);
  assert.equal(slotFor(['a', 'b', null, 'd'], 'x', [0, 1, 2, 3], alive(['a', 'b', 'd'])), 2);
  assert.equal(slotFor(['a', 'gone', 'c', 'd'], 'x', [0, 1, 2, 3], alive(['a', 'c', 'd'])), 1);
  assert.equal(slotFor(['a', 'b', 'c', 'd'], 'x', [2, 0, 3, 1], alive(['a', 'b', 'c', 'd'])), 2);
  assert.deepEqual(touch([0, 1, 2, 3], 1), [0, 2, 3, 1]);
});

// #99b25c: 4分割を開いている時に判断待ちの「答える」を押しても何も出なかった
test('opening a task in the quad view always shows it somewhere', () => {
  const live = alive(['a', 'b', 'c', 'd', 'x']);
  const hidden = planOpen({ ...base, main: 'quad' }, 'x', true, live);
  assert.equal(hidden.target, 'panes');
  assert.deepEqual(hidden.slots, ['x', 'b', 'c', 'd']);
  assert.equal(hidden.activeSlot, 0);
  assert.deepEqual(hidden.recent, [1, 2, 3, 0]);

  const already = planOpen({ ...base, main: 'quad' }, 'c', true, live);
  assert.equal(already.target, 'panes');
  assert.equal(already.activeSlot, 2);
  assert.equal(already.slots, base.slots);

  // チャットを横に並べている時は、パネルを入れ替えずにチャットに出す
  const withChat = planOpen({ ...base, main: 'quad', chat: true }, 'x', true, live);
  assert.equal(withChat.target, 'chat');
  assert.equal(withChat.slots, base.slots);
  // 画面が狭くてチャットを並べられない時はパネルに出す
  assert.equal(planOpen({ ...base, main: 'quad', chat: true }, 'x', false, live).target, 'panes');
});

test('opening a task in the focus view replaces the big pane unless chat is beside it', () => {
  assert.deepEqual(planOpen({ ...base, main: 'focus', focusId: 'a' }, 'x', true, alive(['a', 'x'])).focusId, 'x');
  const withChat = planOpen({ ...base, main: 'focus', focusId: 'a', chat: true }, 'x', true, alive(['a', 'x']));
  assert.equal(withChat.target, 'chat');
  assert.equal(withChat.focusId, 'a');
});

test('opening a task from the list or the files shows the chat even if it was hidden', () => {
  for (const main of ['cards', 'compact', 'files'] as const) {
    const plan = planOpen({ ...base, main }, 'x', true, alive(['x']));
    assert.equal(plan.target, 'chat');
    assert.equal(plan.chat, true);
  }
});
