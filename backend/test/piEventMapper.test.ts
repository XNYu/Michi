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

  test("keeps successful turns on the normal completion path", () => {
    const ctx = context();
    Array.from(mapAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "你好" }],
        usage: {
          input: 10,
          output: 2,
          cost: { total: 0.01 },
        },
      },
    }, ctx));

    const events = Array.from(mapAgentEvent({ type: "agent_end" }, ctx));
    assert.equal(events.some((event) => event.kind === "runtime_error"), false);
    assert.deepEqual(events[events.length - 1], { kind: "turn_end" });
    assert.deepEqual(ctx.cumulative, {
      inputTokens: 10,
      outputTokens: 2,
      totalCost: 0.01,
    });
  });

  test("does not turn an aborted assistant message into a provider error", () => {
    const ctx = context();
    Array.from(mapAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      },
    }, ctx));

    const events = Array.from(mapAgentEvent({ type: "agent_end" }, ctx));
    assert.equal(events.some((event) => event.kind === "runtime_error"), false);
  });
});
