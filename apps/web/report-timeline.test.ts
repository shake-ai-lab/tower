import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Report, Session } from '@tower/shared';
import { ReportCard, WorkspaceStrip } from './src/components/SessionDetail';
import { mergedSinceReport, needsYou, reportContext, reportIsStale, taskState, verificationIsStale } from './src/task-state';
import { verifyBadge } from './src/lib';

const report: Report = { request: '変更を取り込む', outcome: 'partial', summary: ['修正済み', '残り: 画面確認'], changedFiles: [], needsDecision: '取り込んでください', nextStep: 'Towerが取り込みを再実行します', raw: '原文を保存', generatedAt: 100 };
const session = (patch: Partial<Session> = {}): Session => ({
  id: 'fixture', status: 'idle', pending: null, report, completedByUser: null, lastInstructionAt: 50,
  verification: { at: 110, ok: true, command: 'test', output: '', durationMs: 1 },
  workspace: { path: 'fixture', root: 'fixture', branch: 'fixture', baseBranch: 'main', baseCommit: 'base', lastMerge: { at: 120, ok: true, message: '取り込みました' } },
  ...patch,
} as Session);

test('取り込み後の返事は書き換えずに原文をそのまま出し、取り込んだことだけを添える', () => {
  const s = session();
  const html = renderToStaticMarkup(createElement(ReportCard, { r: report, context: reportContext(s) }));
  assert.match(html, /この返事の後、変更を元のプロジェクトに取り込みました/);
  // 以前の決まった書式の報告は、結果の札を残す
  assert.match(html, /一部完了/);
  // 本文はエージェントが書いた原文。Tower が読み取った欄（判断が必要・次の一手など）は並べない
  assert.match(html, /原文を保存/);
  assert.doesNotMatch(html, /判断が必要|次の一手|やったこと|補足|Tower が整形|原文を見る|残り: 画面確認/);
  assert.equal(report.nextStep, 'Towerが取り込みを再実行します');
});

test('今の返事: 結果の札は出さず、本文と変えたファイル（作業フォルダからのパス）を出す', () => {
  const reply: Report = { request: '直して', outcome: 'unknown', summary: [], changedFiles: ['C:\\proj\\src\\a.ts', 'D:\\other\\b.ts'], needsDecision: null, nextStep: null, raw: '## 直しました\n- `src/a.ts` を変更', generatedAt: 100 };
  const linker = { root: 'C:\\proj', open: () => {}, imageUrl: (p: string) => p };
  const html = renderToStaticMarkup(createElement(ReportCard, { r: reply, linker }));
  assert.match(html, /💬 返事/);
  assert.doesNotMatch(html, /📝|💬 返事あり|一部完了|完了/);
  assert.match(html, /直しました/);
  assert.match(html, /変更したファイル（2）/);
  assert.match(html, />src\/a\.ts<\/button>/);
  assert.match(html, />D:\\other\\b\.ts<\/button>/);
  // 失敗で終わった時だけ札を出す
  assert.match(renderToStaticMarkup(createElement(ReportCard, { r: { ...reply, outcome: 'failed' } })), /失敗/);
});

test('取り込み済みでは未反映と説明せず、再取り込みボタンを無効にする', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceStrip, { s: session() }));
  assert.match(html, /再度取り込む必要はありません/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>取り込み済み<\/button>/);
  assert.doesNotMatch(html, /反映されません|元のプロジェクトに取り込む<\/button>/);
});

test('取り込み失敗では提案を履歴にせず、取り込み操作を残す', () => {
  const s = session();
  s.workspace!.lastMerge!.ok = false;
  assert.equal(reportContext(s), 'current');
  assert.equal(needsYou(s), true);
  const html = renderToStaticMarkup(createElement(WorkspaceStrip, { s }));
  assert.doesNotMatch(html, /<button[^>]* disabled=""/);
  assert.match(html, /元のプロジェクトに取り込む<\/button>/);
});

test('取り込み後の再開・停止・エラーでは旧報告と旧チェックを現在と扱わない', () => {
  for (const status of ['running', 'stopped', 'error', 'idle', 'done'] as const) {
    const s = session({ status, lastInstructionAt: 200 });
    assert.equal(reportIsStale(s), true);
    assert.equal(reportContext(s), 'previous');
    assert.equal(mergedSinceReport(s), false);
    assert.equal(verificationIsStale(s), true);
    assert.equal(verifyBadge(s)?.text, '前回のチェック');
    assert.equal(needsYou(s), false);
    assert.notEqual(taskState(s), 'merged');
    assert.notEqual(taskState(s), 'done');
  }
});

test('新しい報告は新しい案内として表示し、古い検証を新報告の裏取りに使わない', () => {
  const s = session({ lastInstructionAt: 200, report: { ...report, generatedAt: 300, outcome: 'done', needsDecision: null }, verification: { at: 110, ok: false, command: 'test', output: '', durationMs: 1 } });
  assert.equal(reportContext(s), 'current');
  assert.equal(mergedSinceReport(s), false);
  assert.equal(verificationIsStale(s), true);
  assert.equal(taskState(s), 'done');
  s.verification!.at = 310;
  assert.equal(verificationIsStale(s), false);
  assert.equal(taskState(s), 'mismatch');
});

test('利用者による完了後の提案は履歴、新しい指示があれば前回報告になる', () => {
  const s = session({ status: 'done', completedByUser: 130 });
  assert.equal(reportContext(s), 'completed');
  s.lastInstructionAt = 200;
  assert.equal(reportContext(s), 'previous');
});

test('取り込み後の手動編集は追加取り込みを可能にする', () => {
  const s = session({ manualEdits: ['edited.txt'], lastManualEditAt: 150 });
  assert.equal(mergedSinceReport(s), false);
  assert.equal(reportContext(s), 'merged', '追加の編集だけで古い提案を復活させない');
  assert.equal(needsYou(s), false, '追加の編集だけで古い判断待ちに戻さない');
  const html = renderToStaticMarkup(createElement(WorkspaceStrip, { s }));
  assert.match(html, /追加の変更を取り込む/);
  assert.doesNotMatch(html, /<button[^>]* disabled=""/);
  s.workspace!.lastMerge!.at = 160;
  assert.equal(mergedSinceReport(s), true, '手動編集の連絡メモが残っても、追加取り込み後は取り込み済み');
});

test('取り込み以前の指示と同時刻の報告・検証は古い扱いにしない', () => {
  const s = session({ lastInstructionAt: 100, verification: { at: 100, ok: true, command: 'test', output: '', durationMs: 1 } });
  assert.equal(reportIsStale(s), false);
  assert.equal(verificationIsStale(s), false);
  assert.equal(mergedSinceReport(s), true);
});
