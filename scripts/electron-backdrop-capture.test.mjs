import assert from 'node:assert/strict';
import test from 'node:test';
import { backdropCaptureBounds, backdropImageWidth } from '../electron/dist/backdropCapture.js';

const content = { width: 1440, height: 900 };

test('captures the requested window region in window points', () => {
  assert.deepEqual(backdropCaptureBounds({ x: 0, y: 0, width: 1440, height: 900 }, 1, content), { x: 0, y: 0, width: 1440, height: 900 });
  // Page zoom: CSS pixels times the zoom factor.
  assert.deepEqual(backdropCaptureBounds({ x: 0, y: 0, width: 720, height: 450 }, 2, content), { x: 0, y: 0, width: 1440, height: 900 });
});

test('clips to the window and rejects what is left empty or malformed', () => {
  assert.deepEqual(backdropCaptureBounds({ x: -20, y: -10, width: 2000, height: 2000 }, 1, content), { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(backdropCaptureBounds({ x: 1500, y: 0, width: 100, height: 100 }, 1, content), null);
  assert.equal(backdropCaptureBounds({ x: 0, y: 0, width: 'wide', height: 10 }, 1, content), null);
  assert.equal(backdropCaptureBounds(null, 1, content), null);
});

test('downscales the capture to a quarter before it crosses IPC', () => {
  assert.equal(backdropImageWidth({ x: 0, y: 0, width: 1440, height: 900 }), 360);
  assert.equal(backdropImageWidth({ x: 0, y: 0, width: 2, height: 2 }), 1);
});
