import type { AgentRuntime } from '../types';
import type { NativeToolMode, RuntimeRunAdapter, SteeringStrategy } from './runtimeRunAdapter';

/**
 * Kiro Run adapter.
 *
 * - **nativeToolMode `runtime_default`**: Kiro provides its own native tool
 *   set (shell, filesystem, search, etc.) and Michi injects only the
 *   per-session MCP slot tools (including `submit_agent_result` for
 *   `agent_run` owners). Michi does not enumerate Kiro's native tools.
 *
 * - **steering `native`**: `_session/steer` queues input at the next agent
 *   boundary without cancelling the current prompt.
 *
 * - **supportsNativeResume `true`**: Kiro can resume from a persisted ACP
 *   session id.
 */
export class KiroRunAdapter implements RuntimeRunAdapter {
  readonly runtimeId = 'kiro';
  readonly supportsNativeResume = true;
  readonly nativeToolMode: NativeToolMode = 'runtime_default';
  readonly steering: SteeringStrategy = 'native';
  readonly immediateSteering = 'next_turn' as const;

  assertCompatible(runtime: AgentRuntime): void {
    if (runtime.id !== this.runtimeId) {
      throw new Error(`Kiro Run adapter cannot execute runtime ${runtime.id}`);
    }
    if (!runtime.capabilities.nativeResume) {
      throw new Error('Kiro runtime is incompatible: native-resume capability is required by Agent Runs');
    }
  }
}
