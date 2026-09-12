// Codex の app-server（VS Code の Codex 拡張と同じ本式のつなぎ方）と、標準入出力の 1 行 1 JSON で話す。
// 形は JSON-RPC 2.0 から "jsonrpc" を抜いたもの:
//   要求 {id, method, params} → 応答 {id, result} / {id, error}、通知 {method, params}
// Codex からも要求が来る（許可・質問・Tower が渡した道具の呼び出し）。onRequest が返した値をそのまま応答にする
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type RpcId = string | number;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code = -32000,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Incoming {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class RpcClient {
  private nextId = 1;
  private waiting = new Map<RpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closedWith: Error | null = null;

  /** Codex からの知らせ（作業の進み具合・手番の終わり・使った量など） */
  onNotification: (method: string, params: unknown) => void = () => {};
  /** Codex からの問い合わせ。返した値が応答になる。投げたらエラー応答を返す */
  onRequest: (method: string, params: unknown, id: RpcId) => Promise<unknown> = async (method) => {
    throw new RpcError(`Tower はこの問い合わせに対応していません: ${method}`, -32601);
  };
  /** つながりが切れた（Codex が終了した・書き込めなくなった） */
  onClose: (err: Error) => void = () => {};

  constructor(
    input: Readable,
    private output: Writable,
  ) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => this.receive(line));
    rl.on('close', () => this.close(new Error('Codex との接続が切れました')));
    output.on('error', (e) => this.close(e));
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.closedWith) this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  /** 待っている要求を全部失敗にして閉じる（何度呼んでもよい） */
  close(err: Error) {
    if (this.closedWith) return;
    this.closedWith = err;
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
    this.onClose(err);
  }

  private send(msg: object) {
    try {
      this.output.write(`${JSON.stringify(msg)}\n`);
    } catch (e) {
      this.close(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private receive(line: string) {
    const t = line.trim();
    if (!t) return;
    let msg: Incoming;
    try {
      msg = JSON.parse(t) as Incoming;
    } catch {
      return; // JSON でない行（ログなど）は読み飛ばす
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      void this.answer(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method !== undefined) {
      try {
        this.onNotification(msg.method, msg.params);
      } catch (e) {
        console.error(`[codex] 知らせ ${msg.method} の処理で失敗:`, e);
      }
      return;
    }
    if (msg.id === undefined) return;
    const w = this.waiting.get(msg.id);
    if (!w) return;
    this.waiting.delete(msg.id);
    if (msg.error) w.reject(new RpcError(msg.error.message ?? 'Codex がエラーを返しました', msg.error.code, msg.error.data));
    else w.resolve(msg.result);
  }

  private async answer(id: RpcId, method: string, params: unknown) {
    try {
      const result = await this.onRequest(method, params, id);
      if (!this.closedWith) this.send({ id, result: result ?? {} });
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(e instanceof Error ? e.message : String(e));
      if (!this.closedWith) this.send({ id, error: { code: err.code, message: err.message } });
    }
  }
}
