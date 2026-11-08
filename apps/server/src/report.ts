// 返事: エージェントの最後の返事を、書き換えずにそのまま持つ。
// Tower はエージェントに書式を頼まない（出力を変えない）。完了か・判断が要るかは読み取らず、返事が来たら「あなたの番」にする（画面の task-state.ts）。
import type { Report } from '@tower/shared';

/**
 * 1 回の手番の終わりに来た返事。
 * @param text         エージェントの最後の返事（Markdown のまま）
 * @param request      その手番のきっかけになった指示（1 行目）
 * @param changedFiles この手番で変えたファイル
 * @param isError      エラーで終わった
 */
export function replyReport(text: string, request: string, changedFiles: string[], isError: boolean): Report {
  return {
    request,
    outcome: isError ? 'failed' : 'unknown',
    summary: [],
    changedFiles,
    needsDecision: null,
    nextStep: null,
    raw: text,
    generatedAt: Date.now(),
  };
}

/** 指示の 1 行目（Tower が足した補足は 2 行目以降なので入らない） */
export function instructionLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 200);
}
