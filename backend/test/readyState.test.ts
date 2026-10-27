import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getWarmStatus,
  markReady,
  markFailed,
  __resetWarmStatusForTest,
} from '../src/services/readyState';

describe('readyState', () => {
  beforeEach(() => __resetWarmStatusForTest());

  test('markReady is write-once (cannot overwrite failed)', () => {
    markFailed(new Error('boom'));
    markReady();
    assert.equal(getWarmStatus().status, 'failed');
  });

  test('markFailed is write-once (cannot overwrite ready)', () => {
    markReady();
    markFailed(new Error('boom'));
    assert.deepEqual(getWarmStatus(), { status: 'ready', error: null });
  });
});
