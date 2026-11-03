import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFeatureList, michiDisabledFeatures } from '../electron/dist/chromiumFeatures.js';

// Chromium 146 (Electron 41) and Chromium 152 names of the same feature.
const VSYNC = ['VSyncAlignedPresent', 'VSyncAlignedPresentationForScrolling'];

test('turns off vsync-aligned presentation on macOS only', () => {
  assert.deepEqual(michiDisabledFeatures('darwin', {}), VSYNC);
  assert.deepEqual(michiDisabledFeatures('win32', {}), []);
  assert.deepEqual(michiDisabledFeatures('linux', {}), []);
});

test('MICHI_KEEP_VSYNC_PRESENTATION=1 keeps Chromium default for comparison', () => {
  assert.deepEqual(michiDisabledFeatures('darwin', { MICHI_KEEP_VSYNC_PRESENTATION: '1' }), []);
  assert.deepEqual(michiDisabledFeatures('darwin', { MICHI_KEEP_VSYNC_PRESENTATION: '0' }), VSYNC);
});

test('merges into an existing --disable-features value without duplicates', () => {
  assert.equal(mergeFeatureList('', ['A']), 'A');
  assert.equal(mergeFeatureList('Foo,Bar', ['A']), 'Foo,Bar,A');
  assert.equal(mergeFeatureList(' Foo , A ,', ['A', 'B']), 'Foo,A,B');
});
