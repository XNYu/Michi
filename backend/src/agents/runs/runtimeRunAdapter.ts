import type { AgentRuntime, RuntimeId, RuntimeSessionOwner } from '../types';
import { assertOwner } from '../types';

// ---------------------------------------------------------------------------
// Runtime Run Adapter — shared contract for all durable Agent Run runtimes
// ---------------------------------------------------------------------------

/**
 * Native tool mode declares how the runtime exposes tools to the agent:
 *
 * - `'allowlist'`: The runtime exposes **only** the tools listed in
 *   `RuntimeToolProfile.allowedToolNames`. Michi is the single source of truth
 *   for the tool surface. Pi and Claude use this mode.
 *
 * - `'runtime_default'`: The runtime uses its own native tool set (shell,
 *   filesystem, search, etc.) **plus** any Michi-managed tools injected via
 *   the per-session MCP slot. Michi does not need to enumerate every native
 *   tool name. The mandatory `submit_agent_result` tool is still injected
 *   explicitly for `agent_run` owners regardless of this setting.
 *   Kiro and Codex use this mode.
 */
export type NativeToolMode = 'allowlist' | 'runtime_default';

/**
 * Steering strategy declares how supplemental input is delivered mid-turn:
 *
 * - `'native'`: The runtime supports same-turn steering (e.g. Codex
 *   `turn/steer`). The Executor delegates directly to the runtime's
 *   `steer()` or `followUp()` method.
 *
 * - `'next_turn'`: The runtime does not support reliable same-turn steering.
 *   Queued input is held until the current turn ends, then sent as a new user
 *   turn. Immediate input cancels the current turn first.
 *
 * - `'none'`: The runtime does not support any form of supplemental input.
 *   The Executor rejects input attempts with a structured error.
 */
export type SteeringStrategy = 'native' | 'next_turn' | 'none';

/**
 * Shared metadata contract for every runtime that can execute durable Agent
 * Runs. The adapter is intentionally thin — runtime-specific session, process,
 * tool, and permission mechanics stay in each Runtime implementation.
 *
 * The adapter owns:
 * 1. Runtime identity and behavioral metadata used by the generic Executor.
 * 2. Compatibility declaration against a live `AgentRuntime`.
 * 3. Documentation of native tool mode and steering strategy.
 *
 * It does NOT own:
 * - Session creation/teardown (that's `AgentRuntime`).
 * - Tool registration or MCP slot management (that's the MCP layer).
 * - Permission brokering (that's the Coordinator/permission snapshot).
 */
export interface RuntimeRunAdapter {
  /** Runtime id this adapter applies to. Must match `AgentRuntime.id`. */
  readonly runtimeId: RuntimeId;

  /**
   * True when the runtime can resume a session from a persisted native token
   * (e.g. Kiro ACP session id, Codex thread id). When false, the Executor
   * always creates a fresh session with replay history instead.
   */
  readonly supportsNativeResume: boolean;

  /**
   * Declares how this runtime exposes tools to the agent.
   * See `NativeToolMode` for semantics.
   */
  readonly nativeToolMode: NativeToolMode;

  /**
   * Declares how this runtime handles supplemental input.
   * See `SteeringStrategy` for semantics.
   */
  readonly steering: SteeringStrategy;

  /** Native steering that requires a live prompt uses a new turn after interruption. */
  readonly immediateSteering?: 'next_turn';

  /**
   * Validates that a live `AgentRuntime` is compatible with this adapter's
   * requirements. Throws a descriptive error when the runtime is missing
   * required capabilities (models, reasoning, native resume, etc.).
   *
   * This check is pure and independently testable — it reads only the
   * runtime's declared capabilities and identity.
   */
  assertCompatible(runtime: AgentRuntime): void;
}

// ---------------------------------------------------------------------------
// RuntimeToolProfile semantics (documentation)
// ---------------------------------------------------------------------------

/**
 * `RuntimeToolProfile` (defined in types.ts) carries two complementary pieces:
 *
 * 1. `allowedToolNames?: readonly string[]`
 *    - For `allowlist` adapters: the exhaustive set of tool names the agent may
 *      call. Tools not listed MUST be denied by the runtime's approval handler.
 *    - For `runtime_default` adapters: the set of **Michi-managed** tools
 *      injected through the MCP slot. Native runtime tools are not listed but
 *      remain available. The mandatory `submit_agent_result` is always
 *      included for `agent_run` owners.
 *
 * 2. `capabilitySnapshot?: JsonValue`
 *    - An immutable public snapshot of the effective capability surface at
 *      Attempt creation time. Used by the runtime for auditing and by the
 *      `RuntimeRunAdapter.assertCompatible()` check. Never contains
 *      credentials or secrets.
 */

// ---------------------------------------------------------------------------
// Release ownership guard
// ---------------------------------------------------------------------------

/**
 * Validates ownership before releasing a runtime session. Every
 * `AgentRuntime.releaseSession()` implementation MUST call this (or an
 * equivalent owner check) when `expectedOwner` is provided.
 *
 * A stale Attempt MUST NOT release a session that has been rebound to a new
 * chat or another Run's session. When ownership does not match, this function
 * throws and the session is left intact for its real owner.
 *
 * @param sessionOwner  The owner currently bound to the session.
 * @param expectedOwner The owner the caller claims. When provided, must match.
 */
export function assertReleaseOwnership(
  sessionOwner: RuntimeSessionOwner,
  expectedOwner: RuntimeSessionOwner | undefined,
): void {
  if (expectedOwner !== undefined) {
    assertOwner(sessionOwner, expectedOwner);
  }
}
