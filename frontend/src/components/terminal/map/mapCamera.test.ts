import { describe, expect, it } from 'vitest';
import {
  AUTO_MAX_ZOOM,
  AUTO_MIN_ZOOM,
  autoCamera,
  boundsOf,
  clampCamera,
  focusIds,
  wheelDeltaPixels,
  wheelZoomFactor,
  zoomAt,
  type Camera,
  type Rect,
} from './mapCamera';

const viewport = { width: 1000, height: 600 };
const padding = 72;

function screenOf(cam: Camera, p: { x: number; y: number }) {
  return { x: p.x * cam.k + cam.x, y: p.y * cam.k + cam.y };
}

describe('zoomAt', () => {
  it('keeps the world point under the anchor fixed', () => {
    const cam = { x: 40, y: -20, k: 0.8 };
    const anchor = { x: 300, y: 200 };
    const world = { x: (anchor.x - cam.x) / cam.k, y: (anchor.y - cam.y) / cam.k };
    const next = zoomAt(cam, anchor, 1.7);
    const s = screenOf(next, world);
    expect(next.k).toBeCloseTo(1.36);
    expect(s.x).toBeCloseTo(anchor.x);
    expect(s.y).toBeCloseTo(anchor.y);
  });

  it('clamps the scale and stays anchored at the limit', () => {
    const next = zoomAt({ x: 0, y: 0, k: 2.9 }, { x: 100, y: 100 }, 10);
    expect(next.k).toBe(3);
    expect(next.x).toBeCloseTo(100 - 100 * (3 / 2.9));
  });
});

describe('wheel normalisation', () => {
  it('converts line and page deltas to pixels', () => {
    expect(wheelDeltaPixels(3, 0, 600)).toBe(3);
    expect(wheelDeltaPixels(3, 1, 600)).toBe(48);
    expect(wheelDeltaPixels(1, 2, 600)).toBe(600);
  });

  it('zooms in for negative deltaY and caps one wheel notch', () => {
    expect(wheelZoomFactor(-5)).toBeGreaterThan(1);
    expect(wheelZoomFactor(5)).toBeLessThan(1);
    expect(wheelZoomFactor(-100)).toBeCloseTo(wheelZoomFactor(-30));
    // Opposite deltas cancel exactly, so a pinch out-and-back returns home.
    expect(wheelZoomFactor(7) * wheelZoomFactor(-7)).toBeCloseTo(1);
  });
});

describe('clampCamera', () => {
  it('keeps a margin of content inside the viewport', () => {
    const content = { width: 2000, height: 1000 };
    const far = clampCamera({ x: 5000, y: -9000, k: 1 }, viewport, content);
    expect(far.x).toBe(viewport.width - 96);
    expect(far.y).toBe(96 - 1000);
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

  it('follows a linear thread for the next three nodes', () => {
    const children = new Map([['r', ['a']], ['a', ['b']], ['b', ['c']], ['c', ['d']]]);
    const positions = new Map(['r', 'a', 'b', 'c', 'd'].map((id, i) => [id, { x: i * 500, y: 0 }]));
    expect(focusIds('r', children, positions, 3)).toEqual(['r', 'a', 'b', 'c']);
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

  it('fits the focus cards and centres them', () => {
    const focus: Rect = { minX: 0, minY: 0, maxX: 900, maxY: 400 };
    const cam = autoCamera({ focus, anchor: { x: 180, y: 78 }, viewport, padding });
    expect(cam.k).toBeCloseTo((1000 - 144) / 900);
    expect(screenOf(cam, { x: 450, y: 200 }).x).toBeCloseTo(viewport.width / 2);
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
