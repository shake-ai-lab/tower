// ごく小さな ToDo 管理。メモリ上に持つだけ。
export class TodoList {
  constructor() {
    this.items = [];
  }

  add(text) {
    if (!text || !text.trim()) throw new Error('empty');
    this.items.push({ text: text.trim(), done: false });
    return this.items.length - 1;
  }

  complete(index) {
    const item = this.items[index + 1];
    if (!item) throw new Error('not found');
    item.done = true;
  }

  remove(index) {
    this.items.splice(index, 1);
  }

  pending() {
    return this.items.filter((i) => !i.done).map((i) => i.text);
  }
}
