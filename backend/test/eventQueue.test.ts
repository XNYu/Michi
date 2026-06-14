import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue } from '../src/agents/eventQueue';

describe('EventQueue', () => {
  it('drainUntilTurnEnd yields events in order and stops at turn_end', async () => {
    const q = new EventQueue(() => {});

    q.push({ kind: 'chunk', text: 'hello' });
    q.push({ kind: 'chunk', text: ' world' });
    q.push({ kind: 'turn_end', stopReason: 'end_turn' });
    // This event should NOT be yielded
    q.push({ kind: 'chunk', text: 'after' });

    const collected: string[] = [];
    for await (const ev of q.drainUntilTurnEnd()) {
      collected.push(ev.kind);
    }

    assert.deepEqual(collected, ['chunk', 'chunk', 'turn_end']);
    q.dispose();
  });

  it('push(null) closes a pending pull', async () => {
    const q = new EventQueue(() => {});

    const pullPromise = q.pull();
    q.push(null);

    const result = await pullPromise;
    assert.equal(result, null);
    q.dispose();
  });

  it('dispose releases a blocked waiter with null', async () => {
    const q = new EventQueue(() => {});

    const pullPromise = q.pull();
    q.dispose();

    const result = await pullPromise;
    assert.equal(result, null);
  });
});
