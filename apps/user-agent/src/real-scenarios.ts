// 本物のプロジェクト（~/project/*）の写しで Tower を回す。npm run dogfood -- --real
// 写しは ~/.tower/dogfood/<runId>/<key>/ に作る（git は clone して送り先を外す、それ以外はコピー）。元のフォルダ・書きかけの変更には触らない。
// パソコン全体に効く導入（pip install など）は毎回断る。写しの中で閉じる npm install は通す。
import os from 'node:os';
import path from 'node:path';
import type { Scenario } from './scenarios.ts';

const P = (name: string) => path.join(os.homedir(), 'project', name);
const NO_GLOBAL = [
  {
    match: /\bpip3?\s+install\b|\bpython\s+-m\s+pip\s+install\b|\buv\s+pip\b|\bconda\s+install\b|\bnpm\s+(?:i|install)\s+(?:-g|--global)\b|\bwinget\b|\bchoco\s+install\b/i,
    reason: 'パソコン全体に入れるのはやめて。今入っているものだけで確かめられる範囲でお願いします',
    tools: ['Bash', 'PowerShell'],
  },
];

export const REAL_SCENARIOS: Scenario[] = [
  {
    key: 'manga-explain',
    source: P('manga'),
    prompt: 'このプロジェクトが全体として何をするものなのか、コードを読まない私にも分かるように説明して。主な流れと、今どこまでできているかを教えて。まだ何も変えないで。',
    permissionMode: 'default',
    denyAlways: NO_GLOBAL,
    goal: '何をするプロジェクトか・主な流れ・進み具合が平易な日本語で分かり、ファイルは何も変わっていない',
  },
  {
    key: 'manga-tests',
    source: P('manga'),
    prompt: 'テストを全部走らせて、落ちているものがあれば原因を調べて直して。直したらもう一度テストを走らせて、通ることを確認して。',
    permissionMode: 'acceptEdits',
    denyAlways: NO_GLOBAL,
    verify: 'python -m pytest -q -x',
    goal: 'テストの結果が分かり、落ちていたものは直っているか、直せない理由（足りない部品など）が分かる',
  },
  {
    key: 'denki-readme',
    source: P('denki-zumen'),
    prompt: 'README の「使い方」が初めての人には難しいので、最初にやることが順番に分かるように書き直して。コマンドはそのままコピペできる形にして。書いてある機能の説明は減らさないで。',
    permissionMode: 'default',
    denyAlways: NO_GLOBAL,
    goal: 'README の使い方が順番に読める形になり、コマンドがコピペできる。書いてあった機能の説明は失われていない',
  },
  {
    key: 'anki-ui',
    source: P('anki-successor'),
    prompt: '復習画面の評価ボタン（もう一度・難しい・できた・簡単）の文字を少し大きくして、押しやすくして。見た目が崩れていないか確認して。',
    permissionMode: 'acceptEdits',
    denyAlways: NO_GLOBAL,
    goal: '評価ボタンが大きく押しやすくなり、見た目の確認ができている',
  },
  {
    key: 'printer-tidy',
    source: P('three-3-printer'),
    prompt: 'このフォルダに何があるか整理して教えて。古そう・使っていなさそうなファイルがあれば、消していいか私が判断できるように候補と理由を挙げて。まだ何も消さないで。',
    permissionMode: 'default',
    denyAlways: NO_GLOBAL,
    goal: 'フォルダの中身が分かり、消す候補と理由が挙がっている。何も消されていない',
  },
];
