import { describe, expect, it } from 'vitest';
import { AUTO_MAX_ZOOM, AUTO_MIN_ZOOM, autoCamera, boundsOf, focusIds, wheelDeltaPixels, type Camera, type Rect } from './mapCamera';

const viewport = { width: 1000, height: 600 };
const padding = 72;

function screenOf(cam: Camera, p: { x: number; y: number }) {
  return { x: p.x * cam.k + cam.x, y: p.y * cam.k + cam.y };
}

describe('wheel normalisation', () => {
  it('converts line and page deltas to pixels', () => {
    expect(wheelDeltaPixels(3, 0, 600)).toBe(3);
    expect(wheelDeltaPixels(3, 1, 600)).toBe(48);
    expect(wheelDeltaPixels(1, 2, 600)).toBe(600);
  });
});

describe('focusIds', () => {
  it('takes the first three child branches of a bushy root in drawn order', () => {
    const children = new Map([['r', ['c3', 'c1', 'c4', 'c2']], ['c1', ['g1']]]);
    // Model order differs from drawn order: c1 is drawn highest.
    const positions = new Map([
      ['r', { x: 0, y: 0 }],
      ['c1', { x: 500, y: 0 }], ['c2', { x: 500, y: 200 }],
      ['c3', { x: 500, y: 400 }], ['c4', { x: 500, y: 600 }],
      ['g1', { x: 1000, y: 0 }],
    ]);
    expect(focusIds('r', children, positions, 3)).toEqual(['r', 'c1', 'c2', 'c3']);
  });

  it('returns the whole graph when it is small and skips unpositioned ids', () => {
    const children = new Map([['r', ['a', 'hidden']]]);
    const positions = new Map([['r', { x: 0, y: 0 }], ['a', { x: 500, y: 0 }]]);
    expect(focusIds('r', children, positions, 3)).toEqual(['r', 'a']);
    expect(focusIds('missing', children, positions, 3)).toEqual([]);
  });
});

describe('autoCamera', () => {
  const card = { width: 360, height: 156 };
  const sizeOf = () => card;

  it('enlarges a small graph, capped at AUTO_MAX_ZOOM, and centres it', () => {
    const positions = new Map([['r', { x: 210, y: 95 }]]);
    const focus = boundsOf(['r'], positions, sizeOf)!;
    const cam = autoCamera({ focus, anchor: positions.get('r')!, viewport, padding });
    expect(cam.k).toBe(AUTO_MAX_ZOOM);
    const centre = screenOf(cam, { x: 210, y: 95 });
    expect(centre.x).toBeCloseTo(viewport.width / 2);
    expect(centre.y).toBeCloseTo(viewport.height / 2);
  });

  it('keeps text readable and anchors the root when the focus overflows', () => {
    const focus: Rect = { minX: 0, minY: 0, maxX: 1400, maxY: 2000 };
    const anchor = { x: 180, y: 78 };
    const cam = autoCamera({ focus, anchor, viewport, padding });
    expect(cam.k).toBe(AUTO_MIN_ZOOM);
    // Root at the top-left: the near edges sit at the padding, no blank gap.
    expect(screenOf(cam, { x: 0, y: 0 }).x).toBeCloseTo(padding);
    expect(screenOf(cam, { x: 0, y: 0 }).y).toBeCloseTo(padding);
  });
});
