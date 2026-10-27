import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue } from '../src/core/eventQueue';

describe('EventQueue', () => {
  it('dispose releases a blocked waiter with null', async () => {
    const q = new EventQueue(() => {});

    const pullPromise = q.pull();
    q.dispose();

    const result = await pullPromise;
    assert.equal(result, null);
  });
});
