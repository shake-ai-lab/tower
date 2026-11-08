import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { connectWs } from './ws';
import { btn } from './lib';

/**
 * 画面のどこかで描けなくなった時に、真っ白にせず案内を出す。タスクはサーバーで動き続けているので、読み込み直せば戻る
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[tower] 画面の表示中に問題が起きました', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center bg-[#0c0e12] text-zinc-200">
        <p className="text-base font-semibold">画面の表示中に問題が起きました。</p>
        <p className="text-sm text-zinc-400">タスクの作業は止まっていません。読み込み直すと元の画面に戻ります。</p>
        <button type="button" onClick={() => location.reload()} className={`${btn.base} ${btn.primary}`}>
          画面を読み込み直す
        </button>
        <p className="mono max-w-xl break-words text-[11px] text-zinc-500">{error.message}</p>
      </div>
    );
  }
}

connectWs();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
