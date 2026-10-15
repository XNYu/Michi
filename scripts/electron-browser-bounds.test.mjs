import assert from 'node:assert/strict';
import test from 'node:test';
import { toSurfaceBounds } from '../electron/dist/browserBounds.js';

test('passes CSS pixels through unchanged at 100% zoom', () => {
  assert.deepEqual(
    toSurfaceBounds({ x: 926, y: 88, width: 594, height: 786 }, 1),
    { x: 926, y: 88, width: 594, height: 786 },
  );
});

test('scales CSS pixels by the host zoom factor', () => {
  assert.deepEqual(
    toSurfaceBounds({ x: 100, y: 40, width: 200, height: 100 }, 1.5),
    { x: 150, y: 60, width: 300, height: 150 },
  );
});

test('places the surface at the viewport under one Zoom In step', () => {
  // View > Zoom In raises the zoom level by 0.5; Chromium's factor is 1.2^level.
  // The renderer reports the viewport in CSS pixels, which are 1/zoom of the
  // window points the pane actually occupies (rounded from the bug screenshot).
  const zoom = 1.2 ** 0.5;
  const bounds = toSurfaceBounds({ x: 926 / zoom, y: 88 / zoom, width: 594 / zoom, height: 786 / zoom }, zoom);
  assert.deepEqual(bounds, { x: 926, y: 88, width: 594, height: 786 });
});

test('rounds edges rather than sizes so adjacent rects do not gap', () => {
  const left = toSurfaceBounds({ x: 10.4, y: 0, width: 10.4, height: 10 }, 1);
  const right = toSurfaceBounds({ x: 20.8, y: 0, width: 10, height: 10 }, 1);
  assert.equal(left.x + left.width, right.x);
});

test('falls back to 100% for an unusable zoom factor', () => {
  const rect = { x: 10, y: 20, width: 30, height: 40 };
  for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(toSurfaceBounds(rect, zoom), { x: 10, y: 20, width: 30, height: 40 });
  }
});

test('keeps the surface at least one point in each dimension', () => {
  assert.deepEqual(
    toSurfaceBounds({ x: 0, y: 0, width: 0, height: 0.2 }, 1),
    { x: 0, y: 0, width: 1, height: 1 },
  );
});

test('rejects malformed rects', () => {
  for (const value of [
    null,
    undefined,
    'rect',
    { x: 0, y: 0, width: 10 },
    { x: Number.NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
    { x: '0', y: 0, width: 10, height: 10 },
  ]) {
    assert.equal(toSurfaceBounds(value, 1), null);
  }
});
