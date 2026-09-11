// Monaco をローカル同梱で使う設定（既定は CDN から読みに行くので、オフラインでも動くようにする）。
// FileEditor からだけ読み込まれる（画面全体の初期読み込みを重くしない）。
// monaco-editor 0.56 の入口: パッケージの exports が "./*" → "./esm/vs/*.js" なので、esm/vs を書かずに指定する。
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import cssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import htmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// 型の検査はしない（プロジェクトの設定や依存が無い状態で赤線だらけになるのを避ける。構文の間違いだけ出す）
for (const d of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

loader.config({ monaco });

export { monaco };
