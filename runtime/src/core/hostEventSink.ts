import type { NormalizedEvent } from '../contract/events';
import type { McpSlotEventSink } from '../contract/mcp';

/**
 * The sink an adapter gives its session's MCP slot (McpSlotCallbacks.sink):
 * each report the host's tools make goes to `push` as a host_event, at once
 * and in the order made, so it lands on the session's event stream before
 * the tool answers the agent. A report without a payload carries null, as a
 * host_event always has one. `push` is called per report, so it can read the
 * session's current queue.
 */
export function hostEventSink(push: (event: NormalizedEvent) => void): McpSlotEventSink {
  return {
    emit: ({ type, payload }) => push({ kind: 'host_event', type, payload: payload === undefined ? null : payload }),
  };
}
