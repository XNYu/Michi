import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue } from '../src/agents/eventQueue';

describe('EventQueue idle pump simulation', () => {
  it('dispose() unblocks pending pull with null', async () => {
    const queue = new EventQueue(() => {});

    const pullPromise = queue.pull();
    queue.dispose();

    const result = await pullPromise;
    assert.equal(result, null);
  });
});
