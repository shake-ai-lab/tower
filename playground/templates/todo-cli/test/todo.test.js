import test from 'node:test';
import assert from 'node:assert/strict';
import { TodoList } from '../src/todo.js';

test('add and list', () => {
  const t = new TodoList();
  t.add('牛乳を買う');
  t.add('洗濯');
  assert.deepEqual(t.pending(), ['牛乳を買う', '洗濯']);
});

test('complete marks the right item', () => {
  const t = new TodoList();
  t.add('A');
  t.add('B');
  t.complete(0);
  assert.deepEqual(t.pending(), ['B']);
});

test('remove', () => {
  const t = new TodoList();
  t.add('A');
  t.add('B');
  t.remove(0);
  assert.deepEqual(t.pending(), ['B']);
});
