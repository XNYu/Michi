import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAgentEvent, type MapperContext } from '../src/agents/pi/eventMapper';

function ctx(): MapperContext {
  return { cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 }, runStartMs: Date.now() };
}

describe('eventMapper', () => {
  test('maps Pi turn_start/turn_end to harness_lifecycle, not ChatHub done', () => {
    const events = [
      ...mapAgentEvent({ type: 'turn_start' }, ctx()),
      ...mapAgentEvent({ type: 'turn_end' }, ctx()),
    ];
    assert.deepEqual(events.map((e) => e.kind), ['harness_lifecycle', 'harness_lifecycle']);
    assert.equal(events.some((e) => e.kind === 'turn_end'), false);
  });

  test('maps tool_execution_update to tool_call_update', () => {
    const events = [...mapAgentEvent({
      type: 'tool_execution_update',
      toolCallId: 'tc1',
      toolName: 'bash',
      args: { cmd: 'ls' },
    }, ctx())];
    assert.equal(events[0]?.kind, 'tool_call_update');
    assert.equal(events[0] && 'status' in events[0] ? events[0].status : '', 'in_progress');
  });

  test('agent_end still closes the Michi turn with native usage', () => {
    const events = [...mapAgentEvent({ type: 'agent_end' }, ctx())];
    assert.equal(events.at(-1)?.kind, 'turn_end');
    const usage = events.find((e) => e.kind === 'usage_summary');
    assert.equal(usage && 'source' in usage ? usage.source : undefined, 'native');
  });

  test('maps compaction and retry when present, ignores when absent', () => {
    const present = [
      ...mapAgentEvent({ type: 'compaction_start' }, ctx()),
      ...mapAgentEvent({ type: 'auto_retry_start' }, ctx()),
    ];
    assert.deepEqual(present.map((e) => e.kind), ['compaction_start', 'retry_start']);
    const absent = [...mapAgentEvent({ type: 'unknown_noise' }, ctx())];
    assert.equal(absent.length, 0);
  });
});
