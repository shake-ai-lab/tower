import type { Locator, Page } from 'playwright-core';

export type BrowserAction = { action: 'click' | 'type' | 'press' | 'select' | 'scroll' | 'finish'; target: number; value: string };

/** Visible DOM targets and browser input only. Shared by AI exploration and its regression journey. */
export async function performAction(page: Page, decision: BrowserAction, targets: Locator[]) {
  if (!Number.isInteger(decision.target) || decision.target < -1 || typeof decision.value !== 'string' || decision.value.length > 2000) throw new Error('不正な操作パラメーター');
  const target = targets[decision.target];
  if (decision.target !== -1 && !target) throw new Error('画面にその操作対象がありません');
  if (['click', 'select'].includes(decision.action) && !target) throw new Error('操作対象を指定してください');
  if (decision.action === 'finish') return;
  if (decision.action === 'click') {
    // Monaco は描画レイヤーが入力要素を覆う。見えている座標へ人と同じクリックを送る。
    const box = await target.boundingBox();
    if (!box) throw new Error('操作対象が画面から消えました');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else if (decision.action === 'type') {
    if (target) await target.focus();
    await page.keyboard.type(decision.value, { delay: 60 });
  } else if (decision.action === 'select') await target.selectOption({ label: decision.value }, { timeout: 3000 });
  else if (decision.action === 'press') {
    if (target) await target.focus();
    if (!/^(?:(?:Control|Meta|Alt|Shift)\+)*(?:[a-zA-Z0-9,./\\-]|Enter|Escape|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|Backspace|Delete|Space)$/.test(decision.value)) throw new Error('対応していないキー');
    await page.keyboard.press(decision.value);
  } else if (decision.action === 'scroll') {
    if (!['up', 'down'].includes(decision.value)) throw new Error('スクロール方向はup/downです');
    if (target) { const box = await target.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); }
    await page.mouse.wheel(0, decision.value === 'up' ? -500 : 500);
  } else throw new Error('対応していない操作');
}
