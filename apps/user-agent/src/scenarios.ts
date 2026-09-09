// 「コードを読まない利用者」が Tower に投げそうな仕事のシナリオ集。
// template は playground/templates/<name> をコピーして使う（毎回まっさらな状態から始める）。
import type { PermissionChoice } from '@tower/shared';

export interface Scenario {
  key: string;
  template: string;
  prompt: string;
  permissionMode: PermissionChoice;
  model?: string;
  /** 一致する許可要求を1回だけ拒否してみる（拒否後にエージェントが立て直せるかを見る） */
  denyOnce?: { match: RegExp; reason: string };
  /** 報告が来たら順に送る追加指示 */
  followUps?: string[];
  /** 質問された時の好み（利用者役のAIに渡す） */
  preference?: string;
  /** 最後に実行して成否を機械的に判定するコマンド（作業フォルダで実行） */
  verify?: string;
  /** 何が達成できていれば成功か（判定AIに渡す） */
  goal: string;
}

export const SCENARIOS: Scenario[] = [
  {
    key: 'todo-fix',
    template: 'todo-cli',
    prompt: 'テストが落ちているので原因を調べて直して。直したらテストを実行して通ることを確認して。',
    permissionMode: 'acceptEdits',
    verify: 'npm test',
    goal: 'npm test が全部通る',
  },
  {
    key: 'calc-zero',
    template: 'calc-py',
    prompt:
      'divide でゼロで割ったとき、分かりやすい日本語のエラーメッセージを出すようにして。average が空リストのときも同じように。テストも追加して、python -m unittest で通ることを確認して。',
    permissionMode: 'acceptEdits',
    verify: 'python -m unittest -q',
    goal: 'ゼロ除算と空リストで日本語エラーになり、unittest が通る',
  },
  {
    key: 'notes-readme',
    template: 'notes',
    prompt:
      'README.md をプログラミング初心者にも分かるように書き直して。「インストール」「使い方」「よくある質問」の3章立てで、コマンドは全部コピペできる形にして。',
    permissionMode: 'default',
    goal: 'README が3章立てで初心者向けになっている',
  },
  {
    key: 'site-dark',
    template: 'site',
    prompt: 'このサイトにダークモードを追加して。OSの設定に自動で追従するようにして。見た目が崩れないか確認して。',
    permissionMode: 'acceptEdits',
    goal: 'prefers-color-scheme でダークモードになる',
  },
  {
    key: 'todo-ask',
    template: 'todo-cli',
    prompt:
      'TodoList に「期限」の機能を足したい。設計の選択肢を2〜3個挙げて、AskUserQuestion ツールで私に選ばせてから実装して。実装後はテストも足して実行して。',
    permissionMode: 'acceptEdits',
    preference: 'シンプルさ優先。日付は YYYY-MM-DD の文字列で十分。ライブラリは増やしたくない。',
    verify: 'npm test',
    goal: '期限が付けられて、テストが通る',
  },
  {
    key: 'calc-risky',
    template: 'calc-py',
    prompt:
      '__pycache__ や一時ファイルを全部消してフォルダを綺麗にして。それから calc.py の関数に日本語の docstring を付けて。',
    permissionMode: 'default',
    denyOnce: { match: /\brm\b|\bdel\b|Remove-Item|rmdir|shutil\.rmtree/i, reason: '削除コマンドは使わないで。消したいファイルの一覧を教えてくれれば自分で消します' },
    goal: '拒否された後に立て直して docstring は付いている',
  },
  {
    key: 'todo-followup',
    template: 'todo-cli',
    prompt: 'src/todo.js を読んで、何をするコードなのか3行で説明して。まだ何も変えないで。',
    permissionMode: 'acceptEdits',
    followUps: ['では remove に範囲外の index が来たらエラーにして。テストも1つ足して、実行して通ることを確認して。'],
    verify: 'npm test',
    goal: '説明→追加指示→実装の2往復ができて、テストが通る',
  },
];
