import { describe, expect, it } from 'vitest';
import {
  clampRect,
  defaultRect,
  dockRatioFromPointer,
  firstOpenPlacement,
  INITIAL_METACHAT_STATE,
  isDockHint,
  moveRect,
  parseStoredState,
  readStoredState,
  resizeRect,
  TITLE_BAR_HEIGHT,
} from './metaChatWindowModel';

const area = { width: 1100, height: 850 };

describe('metaChatWindowModel', () => {
  it('places the default box bottom-right at 384×520', () => {
    expect(defaultRect(area)).toEqual({ x: 1100 - 384 - 18, y: 850 - 520 - 18, w: 384, h: 520 });
  });

  it('lets the box hang off the left, right and bottom while half its title bar stays inside', () => {
    const start = { x: 600, y: 300, w: 384, h: 520 };
    expect(moveRect(start, 5000, 5000, area)).toEqual({ x: 1100 - 192, y: 850 - TITLE_BAR_HEIGHT, w: 384, h: 520 });
    expect(moveRect(start, -5000, -5000, area)).toEqual({ x: -192, y: 0, w: 384, h: 520 });
    expect(moveRect(start, -650, 0, area)).toMatchObject({ x: -50 });
    expect(moveRect(start, 300, 0, area)).toMatchObject({ x: 900 });
  });

  it('resizes a box hanging off an edge without snapping it back inside', () => {
    const offLeft = { x: -100, y: 200, w: 384, h: 520 };
    expect(resizeRect(offLeft, 'e', 100, 0, area)).toEqual({ x: -100, y: 200, w: 484, h: 520 });
    expect(resizeRect(offLeft, 'w', -50, 0, area)).toEqual({ x: -100, y: 200, w: 384, h: 520 });
    const offRight = { x: 900, y: 200, w: 384, h: 520 };
    expect(resizeRect(offRight, 'w', -100, 0, area)).toEqual({ x: 800, y: 200, w: 484, h: 520 });
    const offBottom = { x: 300, y: 600, w: 384, h: 520 };
    expect(resizeRect(offBottom, 'e', 40, 0, area)).toEqual({ x: 300, y: 600, w: 424, h: 520 });
    expect(resizeRect(offBottom, 'n', 0, -40, area)).toEqual({ x: 300, y: 560, w: 384, h: 560 });
  });

  it('resizes from every edge and corner without going below 320×300', () => {
    const start = { x: 400, y: 200, w: 384, h: 520 };
    expect(resizeRect(start, 'e', 100, 0, area)).toMatchObject({ x: 400, w: 484 });
    expect(resizeRect(start, 'w', -100, 0, area)).toMatchObject({ x: 300, w: 484 });
    expect(resizeRect(start, 'n', 0, -50, area)).toMatchObject({ y: 150, h: 570 });
    expect(resizeRect(start, 's', 0, 50, area)).toMatchObject({ y: 200, h: 570 });
    expect(resizeRect(start, 'se', -500, -500, area)).toEqual({ x: 400, y: 200, w: 320, h: 300 });
    expect(resizeRect(start, 'nw', 500, 500, area)).toEqual({ x: 400 + 384 - 320, y: 200 + 520 - 300, w: 320, h: 300 });
    expect(resizeRect(start, 'ne', 5000, -5000, area)).toEqual({ x: 400, y: 0, w: 700, h: 720 });
    expect(resizeRect(start, 'sw', -5000, 5000, area)).toEqual({ x: 0, y: 200, w: 784, h: 650 });
  });

  it('shows the dock hint only with the pointer at the right edge', () => {
    expect(isDockHint(1099, area)).toBe(true);
    expect(isDockHint(1060, area)).toBe(true);
    expect(isDockHint(1000, area)).toBe(false);
  });

  it('clamps the divider to 30–70', () => {
    expect(dockRatioFromPointer(550, area)).toBe(50);
    expect(dockRatioFromPointer(10, area)).toBe(70);
    expect(dockRatioFromPointer(1090, area)).toBe(30);
  });

  it('clamps a stored box to a smaller area', () => {
    expect(clampRect({ x: 1500, y: 1200, w: 900, h: 900 }, { width: 800, height: 600 }))
      .toEqual({ x: 400, y: 600 - TITLE_BAR_HEIGHT, w: 800, h: 600 });
  });

  it('reads valid stored values and falls back field by field', () => {
    expect(parseStoredState(JSON.stringify({ form: 'dock', minimized: true, rect: { x: 1, y: 2, w: 400, h: 500 }, dockRatio: 62 })))
      .toEqual({ form: 'dock', minimized: true, rect: { x: 1, y: 2, w: 400, h: 500 }, dockRatio: 62 });
    expect(parseStoredState(JSON.stringify({ form: 'sideways', minimized: 'yes', rect: { x: 'a' }, dockRatio: 'wide' })))
      .toEqual(INITIAL_METACHAT_STATE);
    expect(parseStoredState(JSON.stringify({ rect: { x: 0, y: 0, w: 10, h: 10 }, dockRatio: 95 })))
      .toMatchObject({ rect: { w: 320, h: 300 }, dockRatio: 70 });
    expect(parseStoredState(JSON.stringify({ rect: { x: 0, y: 0, w: -5, h: 10 } }))?.rect).toBeNull();
    expect(parseStoredState('{not json')).toBeNull();
    expect(parseStoredState('[1,2]')).toBeNull();
    expect(parseStoredState('null')).toBeNull();
  });

  it('survives storage that throws', () => {
    const broken = { getItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(readStoredState(broken)).toEqual(INITIAL_METACHAT_STATE);
  });

  describe('first open', () => {
    const at = (width: number) => ({ width, height: 800 });
    const centred = (width: number, column = 768) => ({ left: (width - column) / 2, right: (width + column) / 2 });

    it('floats in the default box when it leaves the page column clear', () => {
      expect(firstOpenPlacement(at(1620), centred(1620))).toEqual({ minimized: false, rect: null });
      // A page whose column ends early, at any width.
      expect(firstOpenPlacement(at(1140), { left: 40, right: 700 })).toEqual({ minimized: false, rect: null });
    });

    it('floats narrower beside the column when a box of at least 320 px fits', () => {
      expect(firstOpenPlacement(at(1500), centred(1500))).toEqual({ minimized: false, rect: { x: 1500 - 18 - 330, y: 800 - 520 - 18, w: 330, h: 520 } });
    });

    it('opens minimised when any box would cover the column', () => {
      // 1440 px window, 300 px sidebar: the Spaces column leaves 186 px each side.
      expect(firstOpenPlacement(at(1140), centred(1140))).toEqual({ minimized: true, rect: null });
      expect(firstOpenPlacement(at(1140), { left: 0, right: 1100 })).toEqual({ minimized: true, rect: null });
    });

    it('assumes the Spaces column while the page has not rendered one, and does nothing before the area is measured', () => {
      expect(firstOpenPlacement(at(1140), null)).toEqual({ minimized: true, rect: null });
      expect(firstOpenPlacement(at(1700), null)).toEqual({ minimized: false, rect: null });
      expect(firstOpenPlacement({ width: 0, height: 0 }, null)).toEqual({ minimized: false, rect: null });
    });
  });
});
