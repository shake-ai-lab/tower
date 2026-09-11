// 報告カード: エージェントに固定書式で報告させ、それを構造化する。
import type { Report, ReportOutcome } from '@tower/shared';

/** システムプロンプトに追記する報告ルール */
export const REPORT_INSTRUCTIONS = [
  '# 報告のルール（最重要）',
  'あなたの利用者はコードを読みません。判断だけをします。ターンの最後（作業が終わった時、または止まって指示を待つ時）は、必ず次の書式で日本語で報告してください。専門用語は避け、中学生にも分かる言葉で。書式のラベルは一字一句このままにしてください。',
  '',
  '【報告】',
  '依頼: （何を頼まれたかを1行で）',
  '結果: （完了 / 一部完了 / 失敗 / 質問あり のどれか1つ）',
  'やったこと:',
  '- （最大5行。何をどう変えたかを平易に）',
  '変更ファイル:',
  '- （変更・作成したファイルのパス。無ければ「なし」）',
  '判断が必要:',
  '（利用者に決めてほしいこと。無ければ「なし」）',
  '次の一手:',
  '（次にやるべきことの提案を1行。無ければ「なし」）',
  '',
  '途中経過の説明は短く。報告の前に長い解説を書かないでください。',
  '',
  '# 書き方の決まり',
  '- ツールを使う時の description（何をするかの説明）は日本語で書く。例: 「テストを実行して確認」',
  '- 「やったこと」にコードや識別子（関数名・変数名・記号・ファイル内の行番号）を書かない。「完了マークが1つずれるバグを直した」のように、何がどう変わったかを普通の言葉で書く。技術的な詳細が必要なら「やったこと」の最後に1行だけ添える',
  '- 「結果」は正直に。テストや動作確認を実際に実行して成功した時だけ「完了」。実行していない・失敗した・一部しかできていない時は「一部完了」か「失敗」にして、何が確認できていないかを「判断が必要」か「次の一手」に書く',
  '- 成果物が文章・画面・メッセージなら、代表的な部分を1〜2行だけ引用する。例: 「ゼロで割ることはできません」と表示されるようにした',
  '- 「次の一手」は、利用者が次に何を指示すればよいかの提案。URL やファイル名はそのまま書いてよい',
  '- 見た目の確認など、あなたには確認できず利用者の目が必要なことが残っているなら「結果」は「一部完了」にして、「判断が必要」に何をどう確認してほしいかを書く。「完了」と書いて「次の一手」で確認を頼む、はしない',
  '- 質問して利用者に決めてもらったことがあれば、「やったこと」の先頭に「決めたこと: 〜」として1行でまとめる',
  '- 頼まれていない変更（ついでに直したバグ等）をしたら、「やったこと」に「（依頼外）」と付けて区別する',
  '- 「結果」が一部完了・失敗の時は、「やったこと」の最後に「残り: 〜」を1行書いて、何ができていないか・なぜかを言う',
  '- テストが落ちた時は、自分の変更が原因かどうかを必ず書く。作業前から落ちていたもの（Tower の補足で知らされる、または自分で気づいた）なら「前からの失敗で、今回の変更とは無関係」と明記する',
  '- 依頼の範囲外のバグを見つけたら、コードの話ではなく「何ができないか」で1行説明して直すか聞く。例: 「完了マークが1つずれる不具合が前からあります。ついでに直しますか？」。「complete メソッドも修正すべきか」のような聞き方はしない',
  '- どうしても必要な専門用語には、括弧で短い説明を添える。例: 「ISO 8601 形式（2026-09-15 のような日付の書き方）」',
].join('\n');

const OUTCOME_MAP: Record<string, ReportOutcome> = {
  完了: 'done',
  一部完了: 'partial',
  失敗: 'failed',
  質問あり: 'question',
};

const LABELS = ['依頼', '結果', 'やったこと', '変更ファイル', '判断が必要', '次の一手'];

function section(body: string, label: string): string {
  const others = LABELS.filter((l) => l !== label).join('|');
  // String.raw: バックスラッシュをそのまま正規表現に渡す
  const re = new RegExp(String.raw`(?:^|\n)${label}[:：]\s*([\s\S]*?)(?=\n(?:${others})[:：]|$)`);
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

const isNone = (s: string) => !s || /^[（(]?(なし|特になし)[）)]?$/.test(s.trim());

/** 「〜を確認してください」「ブラウザで開いて見てください」のような、利用者の目視を頼む文 */
export const ASKS_CHECK = /(確認|見て|開いて|試して|チェック)(して|し|を)?(みて)?(ください|下さい|ほしい|欲しい|いただけ|もらえ)/;

function bullets(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-*・•]+/, '').trim())
    .filter((l) => l && !isNone(l));
}

/** 【報告】書式を解析。見つからなければ null */
export function parseReport(finalText: string, fallbackRequest: string): Report | null {
  const idx = finalText.lastIndexOf('【報告】');
  if (idx < 0) return null;
  const body = finalText.slice(idx + '【報告】'.length).trim();

  const outcomeRaw = section(body, '結果').split(/[\s（(]/)[0] ?? '';
  const needs = section(body, '判断が必要');
  const next = section(body, '次の一手');
  let outcome = OUTCOME_MAP[outcomeRaw] ?? 'unknown';
  // 「完了」なのに利用者に目視確認を頼んでいる = 実際は一部完了。ルールで禁じているが守られない時の保険
  const asksCheck = (s: string) => !isNone(s) && ASKS_CHECK.test(s);
  if (outcome === 'done' && (asksCheck(needs) || asksCheck(next))) outcome = 'partial';

  return {
    request: section(body, '依頼') || fallbackRequest,
    outcome,
    summary: bullets(section(body, 'やったこと')),
    changedFiles: bullets(section(body, '変更ファイル')),
    needsDecision: isNone(needs) ? null : needs,
    nextStep: isNone(next) ? null : next,
    raw: finalText,
    generatedAt: Date.now(),
  };
}

/** 書式がなかった時の保険: 原文の先頭数行をそのまま載せる */
export function fallbackReport(finalText: string, request: string, isError: boolean): Report {
  const lines = finalText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);
  return {
    request,
    outcome: isError ? 'failed' : 'unknown',
    summary: lines,
    changedFiles: [],
    needsDecision: null,
    nextStep: null,
    raw: finalText,
    generatedAt: Date.now(),
  };
}
