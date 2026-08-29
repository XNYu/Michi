/**
 * Owner-aware MCP slot constructor for Agent Runs.
 *
 * Provides a reusable factory that Kiro and Codex (and any future runtime)
 * can call when creating an MCP slot for an Agent Run Attempt. The slot
 * carries:
 *
 * - An immutable `agent_run` owner so `resolveSlotBinding` never performs a
 *   Node lookup.
 * - An explicit `exposedToolNames` allow-list derived from the Run's tool
 *   profile so chat-only tools are never registered and Run-only tools
 *   (e.g. `submit_agent_result`) are only available when the profile
 *   includes them.
 * - A bound `onSubmitAgentResult` callback that delegates to the Attempt's
 *   `RunResultCollector`, enforcing exact owner matching.
 *
 * Chat MCP slots are NOT created through this module — they continue to use
 * the existing `McpSlotRegistry.create()` path with no owner metadata.
 *
 * @module
 */

import type { McpSlotCallbacks } from '../../services/mcpServer';
import type { RuntimeSessionOwner, RuntimeToolProfile } from '../types';
import type { ResultBundleV1 } from 'michi-shared';
import type { AgentRunToolInvoker, AgentRunToolName } from '../runToolBridge';
import type { RunWorkerToolProfile } from './runWorkerTools';
import { SUBMIT_AGENT_RESULT_TOOL } from './runWorkerTools';

/**
 * Options for creating an owner-aware Agent Run MCP slot.
 *
 * All fields related to the Run's identity and tool profile are required.
 * Chat-graph mutation callbacks (spawn_branches, save_artifact, etc.) must
 * still be supplied by the runtime — this factory wires them together with
 * owner metadata and the Run tool surface.
 */
export interface RunMcpSlotOptions {
  /** Immutable `agent_run` owner for this Attempt. */
  owner: RuntimeSessionOwner & { kind: 'agent_run' };

  /** Workspace id for this Run. Used as the authoritative binding — no Node lookup. */
  workspaceId: string | null;

  /** Better-Auth user id of the Run owner. */
  ownerUserId: string | null;

  /** The Run Attempt's tool profile, typically a RunWorkerToolProfile. */
  toolProfile: RuntimeToolProfile;

  /** Chat-graph and artifact callbacks (same as chat slots). */
  chatCallbacks: Omit<
    McpSlotCallbacks,
    'owner' | 'exposedToolNames' | 'agentRuns' | 'agentRunToolNames' | 'onSubmitAgentResult'
  >;

  /** Optional Agent Run tool invoker for delegated spawn/check/wait/cancel. */
  agentRuns?: AgentRunToolInvoker;

  /** Optional explicit Agent Run tool allow-list (subset of AGENT_RUN_TOOL_NAMES). */
  agentRunToolNames?: readonly AgentRunToolName[];
}

/**
 * Build `McpSlotCallbacks` for an Agent Run Attempt.
 *
 * The returned callbacks carry the `owner` and `exposedToolNames` fields that
 * `McpSlotRegistry.create()` propagates onto the `McpSlot`. Downstream tool
 * registration in `buildMcpServerForSlot` uses these to:
 *
 * 1. Skip Node lookup in `resolveSlotBinding` (agent_run owner short-circuit).
 * 2. Only register tools that appear in the exposed set AND have a callback.
 * 3. Bind `submit_agent_result` to the exact Attempt collector via the
 *    `RunWorkerToolProfile.runWorkerTools.submitAgentResult` hook.
 *
 * @throws {Error} If `owner.kind` is not `'agent_run'`.
 */
export function buildRunMcpSlotCallbacks(opts: RunMcpSlotOptions): McpSlotCallbacks {
  if (opts.owner.kind !== 'agent_run') {
    throw new Error('buildRunMcpSlotCallbacks requires an agent_run owner');
  }

  // Build the exposed tool set from the tool profile's allowedToolNames.
  // When the profile has no explicit allow-list, we expose all tools that
  // have callbacks (legacy-compatible path, though Runs should always have
  // an explicit list).
  const exposedToolNames: ReadonlySet<string> | undefined =
    opts.toolProfile.allowedToolNames
      ? new Set(opts.toolProfile.allowedToolNames)
      : undefined;

  // Wire submit_agent_result to the Attempt collector if available.
  const onSubmitAgentResult = resolveSubmitCallback(opts.owner, opts.toolProfile);

  return {
    owner: opts.owner,
    exposedToolNames,
    ...opts.chatCallbacks,
    agentRuns: opts.agentRuns,
    agentRunToolNames: opts.agentRunToolNames,
    onSubmitAgentResult,
  };
}

/**
 * Resolve the `onSubmitAgentResult` callback from a `RunWorkerToolProfile`.
 *
 * Returns `undefined` when:
 * - The tool profile doesn't include `submit_agent_result` in its allow-list.
 * - The tool profile doesn't carry the `runWorkerTools` hook (not a Run profile).
 * - The owner is not `agent_run`.
 *
 * The returned function closes over the exact owner identity, so a mismatched
 * caller triggers the `RunResultCollector`'s ownership check.
 */
function resolveSubmitCallback(
  owner: RuntimeSessionOwner & { kind: 'agent_run' },
  toolProfile: RuntimeToolProfile,
): ((payload: unknown) => ResultBundleV1) | undefined {
  if (!toolProfile.allowedToolNames?.includes(SUBMIT_AGENT_RESULT_TOOL)) return undefined;

  const profile = toolProfile as Partial<RunWorkerToolProfile>;
  if (typeof profile.runWorkerTools?.submitAgentResult !== 'function') return undefined;

  // Close over the owner so the collector can verify identity at call time.
  return (payload) => profile.runWorkerTools!.submitAgentResult(owner, payload);
}
