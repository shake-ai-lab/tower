import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { apiCors, apiGuard } from './guard.ts';

function makeApp() {
  const app = new Hono();
  app.use('/api/*', apiCors);
  app.use('/api/*', apiGuard);
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.post('/api/sessions', (c) => c.json({ ok: true }));
  return app;
}

const post = (app: Hono, headers: Record<string, string>) =>
  app.request('http://127.0.0.1:4800/api/sessions', { method: 'POST', headers, body: '{}' });

test('other sites cannot drive Tower, while its own page, localhost dev and Node callers can', async () => {
  const app = makeApp();
  const json = { 'content-type': 'application/json' };

  // 他のサイトから: 事前確認で許可が付かず、本番の呼び出しも断る
  const preflight = await app.request('http://127.0.0.1:4800/api/sessions', {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  assert.equal((await post(app, { origin: 'https://evil.example', ...json })).status, 403);
  // 事前確認を避ける text/plain でも断る
  assert.equal((await post(app, { origin: 'https://evil.example', 'content-type': 'text/plain' })).status, 403);

  // Tower 画面そのもの（同じ origin。LAN のスマホもこれ）
  assert.equal((await post(app, { origin: 'http://127.0.0.1:4800', ...json })).status, 200);
  const lan = await new Hono().route('/', app).request('http://192.168.1.5:4800/api/sessions', { method: 'POST', headers: { origin: 'http://192.168.1.5:4800', ...json }, body: '{}' });
  assert.equal(lan.status, 200);
  // 同じ origin でも JSON 以外は断る（フォーム送信の悪用防止）
  assert.equal((await post(app, { origin: 'http://127.0.0.1:4800', 'content-type': 'text/plain' })).status, 415);

  // 開発用 Vite
  assert.equal((await post(app, { origin: 'http://localhost:5173', ...json })).status, 200);
  const dev = await app.request('http://127.0.0.1:4800/api/sessions', {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
  });
  assert.equal(dev.headers.get('access-control-allow-origin'), 'http://localhost:5173');

  // Origin の無い呼び出し（hooks・ドッグフーディング）
  assert.equal((await post(app, json)).status, 200);
  // 読むだけ（GET）は誰でも
  assert.equal((await app.request('http://127.0.0.1:4800/api/health', { headers: { origin: 'https://evil.example' } })).status, 200);
});
