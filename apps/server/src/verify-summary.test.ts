import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectVerifyCommand, failedTests, summarizeTestOutput } from './verify.ts';

test('pytest の件数の行が無い時（-qq）は、失敗したテストの行を数える', () => {
  const out = 'E   AssertionError\n=========================== short test summary info ===========================\nFAILED tests/test_tag_lint.py::test_lint_work_over_frozen_works_snapshot - As...\nFAILED tests/test_x.py::test_y\n';
  assert.equal(summarizeTestOutput(out, false), '失敗 2 件（全体の件数は出ていません）');
  assert.equal(summarizeTestOutput('何も分からない出力', false), null);
});

test('件数の行があれば今まで通り', () => {
  assert.equal(summarizeTestOutput('FAILED tests/a.py::t\n1 failed, 312 passed in 20.1s', false), '失敗 1 件・成功 312 件');
});

test('pytest がファイルを読み込めず 1 件も走らなかった時も、失敗の件数とファイル名を拾う', () => {
  const out = 'E   ModuleNotFoundError: No module named \'kaggle_environments\'\n===== short test summary info =====\nERROR tests/test_absorb.py\nERROR tests/test_agents.py\n!!!!! Interrupted: 2 errors during collection !!!!!\n===== 2 errors in 1.25s =====';
  assert.equal(summarizeTestOutput(out, false), '失敗 2 件');
  assert.deepEqual(failedTests(out), ['tests/test_absorb.py', 'tests/test_agents.py']);
  // node:test のファイル単位の行は今まで通り除く
  assert.deepEqual(failedTests('not ok 1 - C:\\x\\a.test.ts\nnot ok 2 - 足し算'), ['足し算']);
});

test('プロジェクト専用の Python（.venv）があればそれでテストを走らせる。別の作業場所なら元のプロジェクトのものを使う', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-verify-'));
  const orig = path.join(root, 'orig');
  const copy = path.join(root, 'copy');
  const rel = process.platform === 'win32' ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python'];
  try {
    for (const d of [orig, copy]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'pyproject.toml'), '[project.optional-dependencies]\ndev = ["pytest"]\n');
    }
    assert.equal(detectVerifyCommand(copy, orig), 'python -m pytest'); // どこにも無ければ PATH の python
    fs.mkdirSync(path.join(orig, ...rel.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(orig, ...rel), '');
    assert.equal(detectVerifyCommand(copy, orig), `"${path.join(orig, ...rel)}" -m pytest`);
    assert.equal(detectVerifyCommand(orig, orig), `${path.join(...rel)} -m pytest`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
