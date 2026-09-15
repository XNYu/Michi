import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatStreamEvent } from 'michi-shared';
import type { AgentSession } from '../src/agents/types';
import { ChatHub } from '../src/agents/chatHub';

test('cancel during durable begin never dispatches the prompt', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let prompts = 0;
  const hub = new ChatHub({ workspaceIdForNode: () => 'workspace',
    persistence: { begin: () => gate, checkpoint() {}, finalize() {} } });
  const session: AgentSession = {
    id: 'node', runtimeId: 'pi', getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() { prompts++; yield { kind: 'turn_end', stopReason: 'end_turn' }; },
    cancel() {},
  };
  const pending = hub.startTurn({ chatId: 'node', nodeId: 'node', text: 'cancel before commit', session, turnId: 'pending-turn' });
  hub.cancel('node', 'pending-turn');
  release();
  const started = await pending;
  await started.done;
  assert.equal(prompts, 0);
  assert.equal(hub.isActive('node'), false);
  const replay: ChatStreamEvent[] = [];
  const unsubscribe = hub.subscribeTurn('node', started.turnId, { send: (event) => replay.push(event), close() {} });
  assert.ok(unsubscribe);
  unsubscribe();
  const terminal = replay.find((event) => event.event === 'done');
  assert.ok(terminal?.event === 'done');
  assert.equal(terminal.data.stopReason, 'cancelled');
});

for (const recoveryRequired of [false, true]) {
  test(`cancelled cleanup ${recoveryRequired ? 'failure remains visible and replayable' : 'without recovery remains graceful'}`, async () => {
    const hub = new ChatHub({ workspaceIdForNode: () => 'workspace',
      persistence: { begin() {}, checkpoint() {}, finalize() {} } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const session: AgentSession = {
      id: 'node', runtimeId: 'pi', getHistory: () => [], getPendingAssistant: () => undefined,
      async *send() {
        await gate;
        yield { kind: 'runtime_error', error: 'Provider did not stop. Restart the backend if it remains unavailable.', recoveryRequired };
      },
      cancel() { release(); },
    };
    const events: ChatStreamEvent[] = [];
    const detach = hub.subscribe('node', { send: (event) => events.push(event), close() {} });
    const turn = await hub.startTurn({ chatId: 'node', nodeId: 'node', text: 'A', session });
    hub.cancel('node', turn.turnId);
    await turn.done;
    detach();
    assert.equal(hub.isActive('node'), false);
    assert.equal(events.some((event) => event.event === 'error'), recoveryRequired);
    if (recoveryRequired) {
      const replay: ChatStreamEvent[] = [];
      let closed = false;
      const unsubscribe = hub.subscribeTurn('node', turn.turnId, {
        send: (event) => replay.push(event), close() { closed = true; },
      });
      assert.ok(unsubscribe);
      unsubscribe();
      assert.equal(closed, true);
      const error = replay.find((event) => event.event === 'error');
      assert.ok(error?.event === 'error');
      assert.match(error.data.message, /Restart the backend/);
    } else {
      const done = events.find((event) => event.event === 'done');
      assert.ok(done?.event === 'done');
      assert.equal(done.data.stopReason, 'cancelled');
    }
  });
}
