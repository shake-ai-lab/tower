// REST の守り: 他のサイトからブラウザ越しに Tower を操作されないようにする。
// 受け付けるのは、Tower 画面そのもの（同じ origin。スマホから開いた時もこれ）と、開発用 Vite（localhost）と、
// Origin を付けない Node からの呼び出し（hooks・ドッグフーディング）だけ。
import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

const ownOrigin = (c: Context) => new URL(c.req.url).origin;

export const allowedOrigin = (origin: string | undefined, c: Context): boolean =>
  !origin || origin === ownOrigin(c) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);

/** 事前確認（preflight）への返事。許さない origin には Access-Control-Allow-Origin を付けない */
export const apiCors: MiddlewareHandler = cors({ origin: (origin, c) => (allowedOrigin(origin, c) ? origin : ''), credentials: false });

/** 書き換える呼び出し（POST/PUT/DELETE…）は、許した origin からの JSON だけ通す */
export const apiGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
  const origin = c.req.header('origin');
  if (!allowedOrigin(origin, c)) return c.json({ error: 'Tower の画面から操作してください' }, 403);
  // フォームや text/plain で送ると事前確認無しで届いてしまうので、ブラウザからは JSON 以外を断る
  if (origin && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON が必要です' }, 415);
  await next();
};
