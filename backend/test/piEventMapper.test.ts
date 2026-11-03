import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mapAgentEvent,
  type MapperContext,
} from "../src/agents/pi/eventMapper";

function context(): MapperContext {
  return {
    cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
    contextWindow: 1_000_000,
    runStartMs: Date.now(),
  };
}

describe("Pi event mapper provider errors", () => {
  test("surfaces an OpenRouter rate-limit error instead of completing an empty turn", () => {
    const ctx = context();
    const errorMessage = '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.","remedy_hint":"Retry shortly or route to another provider."}}';

    const messageEvents = Array.from(mapAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage,
        content: [],
        usage: {
          input: 0,
          output: 0,
          cost: { total: 0 },
        },
      },
    }, ctx));
    assert.deepEqual(messageEvents, []);

    const terminalEvents = Array.from(mapAgentEvent({ type: "agent_end" }, ctx));
    const runtimeError = terminalEvents.find((event) => event.kind === "runtime_error");
    assert.deepEqual(runtimeError, {
      kind: "runtime_error",
      error: "429: stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.\nRetry shortly or route to another provider.",
    });
    assert.deepEqual(terminalEvents[terminalEvents.length - 1], { kind: "turn_end", stopReason: "error" });
  });

  test("preserves a non-JSON provider error verbatim", () => {
    const ctx = context();
    Array.from(mapAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Provider connection closed",
      },
    }, ctx));

    const events = Array.from(mapAgentEvent({ type: "agent_end" }, ctx));
    assert.deepEqual(events.find((event) => event.kind === "runtime_error"), {
      kind: "runtime_error",
      error: "Provider connection closed",
    });
  });
});

describe('eventMapper', () => {
  test('maps Pi turn_start/turn_end to harness_lifecycle, not ChatHub done', () => {
    const events = [
      ...mapAgentEvent({ type: 'turn_start' }, context()),
      ...mapAgentEvent({ type: 'turn_end' }, context()),
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
    }, context())];
    assert.equal(events[0]?.kind, 'tool_call_update');
    assert.equal(events[0] && 'status' in events[0] ? events[0].status : '', 'in_progress');
  });

  test('maps compaction and retry when present, ignores when absent', () => {
    const present = [
      ...mapAgentEvent({ type: 'compaction_start' }, context()),
      ...mapAgentEvent({ type: 'auto_retry_start' }, context()),
    ];
    assert.deepEqual(present.map((e) => e.kind), ['compaction_start', 'retry_start']);
    const absent = [...mapAgentEvent({ type: 'unknown_noise' }, context())];
    assert.equal(absent.length, 0);
  });
});


test('Pi SDK price-table cost has USD units and estimated provenance instead of native credits', () => {
  const ctx = context();
  ctx.cumulative.totalCost = 0.123;
  const summary = Array.from(mapAgentEvent({ type: 'agent_end' }, ctx)).find(event => event.kind === 'usage_summary');
  assert.ok(summary?.kind === 'usage_summary');
  assert.deepEqual(summary.charge, { amount: 0.123, unit: 'USD', provenance: 'sdk_estimate' });
  assert.equal(summary.totalCredits, undefined);
  assert.equal(summary.source, 'estimated');
});


test('successful SDK recovery clears a previous overflow error at the final durable boundary', () => {
  const ctx = context();
  [...mapAgentEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'context overflow' } }, ctx)];
  [...mapAgentEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }, ctx)];
  const events = [...mapAgentEvent({ type: 'agent_end' }, ctx)];
  assert.equal(events.some(event => event.kind === 'runtime_error'), false);
  assert.deepEqual(events.at(-1), { kind: 'turn_end' });
});
