import test from 'node:test';
import assert from 'node:assert/strict';
import { resizeDesk, type DeskRect } from './src/components/DeskWindowControls';
import { deskBounds, deskWheelAction, rotateDesk, scaleText, textScale, wheelZoomFactor, zoomScroll } from './src/desk-geometry';

const keys = (ctrlKey = false, altKey = false, metaKey = false) => ({ ctrlKey, altKey, metaKey });
test('wheel means the same thing wherever the pointer is: plain wheel scrolls, Ctrl/⌘ (or pinch) zooms the desk', () => {
  for (const over of [true, false]) {
    assert.equal(deskWheelAction(keys(), over), 'scroll');
    assert.equal(deskWheelAction(keys(true), over), 'zoom');
    assert.equal(deskWheelAction(keys(false, false, true), over), 'zoom');
  }
  assert.equal(deskWheelAction(keys(true, true), true), 'text');
  assert.equal(deskWheelAction(keys(true, true), false), 'zoom');
  assert.equal(deskWheelAction(keys(false, true), true), 'scroll');
});

test('wheel zoom: one mouse notch is about 1.22x either way, pinch steps are fine, line/page modes are evened out', () => {
  const up = wheelZoomFactor(-100), down = wheelZoomFactor(100);
  assert.ok(Math.abs(up - 1.2214) < 1e-3);
  assert.ok(Math.abs(up * down - 1) < 1e-9);
  assert.ok(wheelZoomFactor(-4) > 1 && wheelZoomFactor(-4) < 1.02);
  assert.equal(wheelZoomFactor(-3, 1), up);
  assert.equal(wheelZoomFactor(1, 2), down);
});

test('zooming keeps the point under the pointer in place', () => {
  const scroll = { left: 1000, top: 500 }, at = { x: 200, y: 100 };
  const zoomed = zoomScroll(scroll, at, 1, 2);
  assert.deepEqual(zoomed, { left: 2200, top: 1100 });
  const back = zoomScroll(zoomed, at, 2, 1);
  assert.deepEqual(back, scroll);
});

const start: DeskRect = { x: 200, y: 150, w: 520, h: 440, angle: 90, z: 1 };
test('rotated right edge resizes in local coordinates without moving the opposite edge', () => {
  const result = resizeDesk(start, 'e', 0, 100);
  assert.equal(result.w, 620);
  assert.equal(result.h, 440);
  assert.equal(result.x, 200);
  assert.equal(result.y, 150);
});

test('rotation preserves the visual center at negative world coordinates', () => {
  const rect = { ...start, x: -800, y: -450, angle: 37 };
  const center = (r: DeskRect) => { const b = deskBounds([r]); return [b.x + b.w / 2, b.y + b.h / 2]; };
  const expected = center(rect);
  for (const result of [rotateDesk(rect, 0), rotateDesk(rect, -90), rotateDesk(rotateDesk(rect, 200), 37)]) {
    center(result).forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-8));
  }
});

test('text size changes only the font multiplier and stays within 60-250%', () => {
  const rect = { ...start, x: -200, y: -100, angle: 0 };
  const bigger = scaleText(rect, 1.15 * 1.15);
  assert.deepEqual({ ...bigger, text: undefined }, { ...rect, text: undefined });
  assert.equal(textScale(rect), 1);
  assert.ok(Math.abs(textScale(bigger) - 1.3225) < 1e-9);
  assert.equal(textScale(scaleText(rect, 20)), 2.5);
  assert.equal(textScale(scaleText(rect, 0)), .6);
  const resized = resizeDesk(bigger, 'se', 100, 50);
  assert.equal(textScale(resized), textScale(bigger));
  assert.equal(resized.w, 620); assert.equal(resized.h, 490);
});

test('rotated northwest resize preserves opposite corner and enforces minimum dimensions', () => {
  const result = resizeDesk(start, 'nw', -40, 60);
  assert.equal(result.w, 460);
  assert.equal(result.h, 400);
  assert.equal(result.x, 160);
  assert.equal(result.y, 210);
  assert.equal(result.x - result.h, start.x - start.h);
  assert.equal(result.y + result.w, start.y + start.w);
  const tiny = resizeDesk({ ...start, angle: 0 }, 'nw', 1000, 1000);
  assert.equal(tiny.w, 300);
  assert.equal(tiny.h, 220);
  assert.equal(tiny.x + tiny.w, start.x + start.w);
  assert.equal(tiny.y + tiny.h, start.y + start.h);
});
