import type { AgentRuntime } from '../types';
import { KIRO_RUN } from 'michi-runtime/internal/adapters/kiro/kiroDescriptor';
import type { NativeToolMode, RuntimeRunAdapter, SteeringStrategy } from './runtimeRunAdapter';

/**
 * Kiro Run adapter. The values come from the Kiro descriptor's run facet.
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
  readonly supportsNativeResume = KIRO_RUN.supportsNativeResume;
  readonly nativeToolMode: NativeToolMode = KIRO_RUN.toolMode;
  readonly steering: SteeringStrategy = KIRO_RUN.steering;
  readonly immediateSteering = KIRO_RUN.immediateSteering;

  assertCompatible(runtime: AgentRuntime): void {
    if (runtime.id !== this.runtimeId) {
      throw new Error(`Kiro Run adapter cannot execute runtime ${runtime.id}`);
    }
    if (!runtime.capabilities.nativeResume) {
      throw new Error('Kiro runtime is incompatible: native-resume capability is required by Agent Runs');
    }
  }
}
