import type { LiveOutput } from '@tower/shared';

export const LIVE_OUTPUT_INTERVAL_MS = 200;
export const LIVE_OUTPUT_MAX_CHARS = 24_000;
export const LIVE_OUTPUT_MAX_ITEMS = 8;

/** deltaは経過に追記せず、実行中の手番の一時表示にまとめる。 */
export class CodexLiveOutput {
  private turnId: string | null = null;
  private items = new Map<string, LiveOutput>();
  private completed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private publish: (items: LiveOutput[] | null) => void) {}

  start(turnId: string) {
    if (this.turnId === turnId) return;
    this.clear();
    this.turnId = turnId;
  }

  append(turnId: string, itemId: string, kind: LiveOutput['kind'], delta: string) {
    if (!turnId || turnId !== this.turnId || !itemId || !delta || this.completed.has(itemId)) return;
    const previous = this.items.get(itemId);
    const text = (previous?.text ?? '') + delta;
    this.items.set(itemId, { itemId, kind, text: text.slice(-LIVE_OUTPUT_MAX_CHARS), truncated: !!previous?.truncated || text.length > LIVE_OUTPUT_MAX_CHARS });
    if (this.items.size > LIVE_OUTPUT_MAX_ITEMS) this.items.delete(this.items.keys().next().value!);
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = null;
      this.emit();
    }, LIVE_OUTPUT_INTERVAL_MS);
  }

  complete(itemId: string) {
    if (!this.turnId || !itemId) return;
    this.completed.add(itemId);
    if (this.items.delete(itemId)) {
      this.cancelTimer();
      this.emit();
    }
  }

  clear() {
    this.cancelTimer();
    this.turnId = null;
    this.completed.clear();
    if (this.items.size) {
      this.items.clear();
      this.publish(null);
    }
  }

  private cancelTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private emit() {
    this.publish(this.items.size ? [...this.items.values()] : null);
  }
}
