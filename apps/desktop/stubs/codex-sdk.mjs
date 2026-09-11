// インストーラ版では @openai/codex-sdk を束ねない（同梱の実行ファイルが 378MB あり、インストーラが倍以上になる）。
// サーバー側は起動時に「見つからない」と判定して、その選択肢を使えない扱いにする。
export class Codex {
  constructor() {
    throw new Error('この版には入っていません');
  }
}
export class Thread {}
