// 本物のサーバーを別の置き場所・空いているポートで起動し、壊れた WebSocket の知らせ 1 つで落ちないことを確かめる。
// （2026-11-08: 画面とのつなぎに error の受け手が無く、壊れた知らせ 1 つでサーバーごと止まっていた）
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

const healthy = async (port: number) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
  } catch {
    return false;
  }
};

/** WebSocket でつなぎ、予約ビットの立った（壊れた）フレームを 1 つ送る */
const sendBrokenFrame = (port: number) =>
  new Promise<void>((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => resolve());
    sock.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    sock.once('data', (d) => {
      assert.match(d.toString(), /^HTTP\/1\.1 101/);
      sock.write(Buffer.from([0xc1, 0x80, 1, 2, 3, 4]));
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 500);
    });
  });

test('a broken WebSocket message from a screen does not take the whole server down', { timeout: 60_000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-ws-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, TOWER_DATA_DIR: data, TOWER_PORT: String(port) },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    for (let i = 0; i < 80 && !(await healthy(port)); i++) await new Promise((r) => setTimeout(r, 250));
    assert.ok(await healthy(port), 'server started');
    await sendBrokenFrame(port);
    await sendBrokenFrame(port);
    assert.equal(child.exitCode, null, 'server process is still running');
    assert.ok(await healthy(port), 'server still answers');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(data, { recursive: true, force: true });
  }
});
