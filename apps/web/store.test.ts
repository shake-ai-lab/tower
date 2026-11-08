import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session, TimelineItem } from '@tower/shared';
import { TIMELINE_CAP, mergeTimeline, useStore } from './src/store';

const item = (sessionId: string, n: number, ts = n): TimelineItem =>
  ({ id: `${sessionId}-${n}`, sessionId, ts, kind: 'assistant_text', text: `行${n}` }) as TimelineItem;
const ids = (sessionId: string) => useStore.getState().timelines[sessionId]?.map((t) => t.id);
const { appendTimeline, loadingTimeline, setTimeline, setSnapshot, removeSession } = useStore.getState();

test('読み込み中に届いた経過は、読み終わった時に混ぜる（重ねず、時刻順に）', () => {
  loadingTimeline('a');
  appendTimeline(item('a', 3));
  appendTimeline(item('a', 2)); // 読んだものにも入っている
  appendTimeline(item('a', 3)); // 2 度届いた
  assert.equal(ids('a'), undefined, '読み終わるまでは出さない');
  setTimeline('a', [item('a', 1), item('a', 2)]);
  assert.deepEqual(ids('a'), ['a-1', 'a-2', 'a-3']);
  // 読み終わった後はそのまま後ろに付く
  appendTimeline(item('a', 4));
  assert.deepEqual(ids('a'), ['a-1', 'a-2', 'a-3', 'a-4']);
});

test('開いていない（読んでいない）セッションの経過は取っておかない', () => {
  appendTimeline(item('b', 1));
  setTimeline('b', [item('b', 2)]);
  assert.deepEqual(ids('b'), ['b-2']);
});

test('同じ経過が 2 度届いても 1 つだけ。何も変わらない時は画面に知らせない', () => {
  setTimeline('c', [item('c', 1)]);
  appendTimeline(item('c', 2));
  let calls = 0;
  const off = useStore.subscribe(() => calls++);
  const before = useStore.getState().timelines.c;
  appendTimeline(item('c', 1));
  appendTimeline(item('c', 2));
  off();
  assert.equal(useStore.getState().timelines.c, before);
  assert.equal(calls, 0);
  assert.deepEqual(ids('c'), ['c-1', 'c-2']);
});

test(`経過は新しい方から ${TIMELINE_CAP} 件まで持つ`, () => {
  setTimeline('d', Array.from({ length: TIMELINE_CAP + 5 }, (_, i) => item('d', i)));
  assert.equal(ids('d')!.length, TIMELINE_CAP);
  assert.equal(ids('d')![0], 'd-5');
  appendTimeline(item('d', TIMELINE_CAP + 5));
  assert.equal(ids('d')!.length, TIMELINE_CAP);
  assert.equal(ids('d')![0], 'd-6');
  assert.equal(ids('d')!.at(-1), `d-${TIMELINE_CAP + 5}`);
  // 手放した後も、残っているものの重なりは見分ける
  appendTimeline(item('d', 500));
  appendTimeline(item('d', TIMELINE_CAP + 5));
  assert.equal(ids('d')!.length, TIMELINE_CAP);
  assert.equal(ids('d')!.at(-1), `d-${TIMELINE_CAP + 5}`);
});

test('2 つの画面が同じ経過を読んでも、間に届いたものを古い読み込みで消さない', () => {
  setTimeline('e', [item('e', 1), item('e', 2)]);
  appendTimeline(item('e', 3));
  setTimeline('e', [item('e', 1), item('e', 2)]); // 先に頼んでいた読み込みが後から届いた
  assert.deepEqual(ids('e'), ['e-1', 'e-2', 'e-3']);
});

test('つなぎ直した後、読み直すまでに届いた経過も混ぜる。消したセッションの分は捨てる', () => {
  setTimeline('f', [item('f', 1)]);
  setTimeline('g', [item('g', 1)]);
  setSnapshot([{ id: 'f' } as Session, { id: 'g' } as Session]);
  assert.equal(ids('f'), undefined);
  appendTimeline(item('f', 2));
  appendTimeline(item('g', 2));
  setTimeline('f', [item('f', 1)]);
  assert.deepEqual(ids('f'), ['f-1', 'f-2']);
  removeSession('g');
  setTimeline('g', [item('g', 1)]);
  assert.deepEqual(ids('g'), ['g-1']);
});

test('混ぜる時は読んだものを優先し、時刻が同じものは元の順のまま', () => {
  const fetched = [{ ...item('h', 1), text: '読んだもの' }, item('h', 2, 5)];
  const merged = mergeTimeline(fetched, [item('h', 1), item('h', 3, 5)], [item('h', 4, 2)]);
  assert.deepEqual(merged.map((t) => t.id), ['h-1', 'h-4', 'h-2', 'h-3']);
  assert.equal(merged[0].text, '読んだもの');
  // 混ぜるものが無ければ並びはそのまま
  assert.equal(mergeTimeline(fetched, [], []), fetched);
});
