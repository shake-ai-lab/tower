import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from './report.ts';

// 本物のプロジェクト（three-3-printer の写し）で出た報告を短くしたもの。変更ファイルの欄のあとに一覧が続いていた
const tidy = `【報告】
依頼: フォルダの中身を整理して説明し、削除候補を提案する
結果: 完了
やったこと:
- フォルダ全体のファイル一覧と、更新日・サイズを確認した
変更ファイル:
なし(確認だけで、変更・削除は行っていません)

■ フォルダの中身(役割別)

**削除候補(動作確認だけのために作った試作品)**
1. \`freecad/output/test_box.FCStd\`・\`test_box.stl\` — 動作確認用
2. \`blender/output/test_torus.stl\` — 動作確認用

判断が必要:
上の2項目を削除してよいか教えてください。
次の一手:
なし`;

test('決まった欄の外に書かれた一覧は「補足」に分け、変更ファイルに混ぜない', () => {
  const r = parseReport(tidy, '')!;
  assert.deepEqual(r.changedFiles, []);
  assert.match(r.details ?? '', /削除候補/);
  assert.match(r.details ?? '', /freecad\/output\/test_box\.FCStd/);
  assert.ok(!(r.details ?? '').includes('**'), '太字の記号は消す');
  assert.equal(r.needsDecision, '上の2項目を削除してよいか教えてください。');
  assert.equal(r.nextStep, null);
});

test('いつもの報告は今まで通り（補足なし・注釈付きのファイル名はパスだけ）', () => {
  const r = parseReport(
    '【報告】\n依頼: ボタンを大きく\n結果: 完了\nやったこと:\n- 文字を大きくした\n変更ファイル:\n- src/components/ReviewCard.css\n- README.md（追記）\n- Dockerfile\n判断が必要:\nなし\n次の一手:\nなし',
    '',
  )!;
  assert.deepEqual(r.changedFiles, ['src/components/ReviewCard.css', 'README.md', 'Dockerfile']);
  assert.equal(r.details, undefined);
  assert.deepEqual(r.summary, ['文字を大きくした']);
});
