import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOutput, codeTerms } from './reformat.ts';

test('利用者向けの文に紛れた識別子を拾う', () => {
  assert.deepEqual(codeTerms('SessionCard.tsx の修正が完了した'), ['SessionCard.tsx', 'SessionCard']);
  assert.deepEqual(codeTerms('`scheduleReformat` を直した'), ['`scheduleReformat`', 'scheduleReformat']);
  assert.deepEqual(codeTerms('npm test を追加した'), ['npm test']);
  assert.deepEqual(codeTerms('build_prompt() の引数を増やした'), ['build_prompt', 'build_prompt()']);
  assert.deepEqual(codeTerms('__pycache__ を消した'), ['__pycache__']);
});

test('普通の日本語・略語・製品名・時刻は拾わない', () => {
  for (const s of [
    '画面の見やすさを直し、テストが全部通ることを確かめた',
    'UI を見直し、QA と同時に点検した',
    'TypeScript と GitHub の設定はそのまま',
    '14:05 に Tower を入れ直した',
    'VS Code の拡張から使えるようにした',
    'テスト 27 本がすべて通った',
  ]) assert.deepEqual(codeTerms(s), [], s);
});

test('原文を報告と取り違えた整形を見分ける', () => {
  const confused = {
    request: '次の作業は何か、確認を求めた',
    summary: ['エージェントからの具体的な作業報告が提供されていない', '整形対象となるべき報告文の確認が必要'],
    needsDecision: 'エージェントが出した報告文（整形すべき対象）は何ですか？',
    nextStep: 'エージェントからの作業報告をお知らせください。その報告を整形して「報告カード」形式にいたします。',
  };
  assert.equal(checkOutput(confused).meta, true);
  const fine = {
    request: '整形がいつ起きるかを知りたい',
    summary: ['報告が決まった書式で読めなかった時だけ整形が走ると説明した', '外のセッションではほぼ毎回走ると説明した'],
    needsDecision: null,
    nextStep: null,
  };
  assert.deepEqual(checkOutput(fine), { meta: false, terms: [] });
});
