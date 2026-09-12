import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTestOutput } from './verify.ts';

test('pytest の件数の行が無い時（-qq）は、失敗したテストの行を数える', () => {
  const out = 'E   AssertionError\n=========================== short test summary info ===========================\nFAILED tests/test_tag_lint.py::test_lint_work_over_frozen_works_snapshot - As...\nFAILED tests/test_x.py::test_y\n';
  assert.equal(summarizeTestOutput(out, false), '失敗 2 件（全体の件数は出ていません）');
  assert.equal(summarizeTestOutput('何も分からない出力', false), null);
});

test('件数の行があれば今まで通り', () => {
  assert.equal(summarizeTestOutput('FAILED tests/a.py::t\n1 failed, 312 passed in 20.1s', false), '失敗 1 件・成功 312 件');
});
