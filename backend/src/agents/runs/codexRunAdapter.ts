import type { AgentRuntime } from '../types';
import type { NativeToolMode, RuntimeRunAdapter, SteeringStrategy } from './runtimeRunAdapter';

/**
 * Codex Run adapter.
 *
 * - **nativeToolMode `runtime_default`**: Codex provides its own native tool
 *   set via the app-server daemon and Michi injects only the per-session MCP
 *   slot tools (including `submit_agent_result` for `agent_run` owners).
 *   Michi does not enumerate Codex's native tools.
 *
 * - **steering `native`**: Codex supports same-turn steering via
 *   `turn/steer`. The Executor delegates directly to the runtime's steer
 *   method.
 *
 * - **supportsNativeResume `true`**: Codex can resume from a persisted
 *   app-server thread id.
 */
export class CodexRunAdapter implements RuntimeRunAdapter {
  readonly runtimeId = 'codex';
  readonly supportsNativeResume = true;
  readonly nativeToolMode: NativeToolMode = 'runtime_default';
  readonly steering: SteeringStrategy = 'native';

  assertCompatible(runtime: AgentRuntime): void {
    if (runtime.id !== this.runtimeId) {
      throw new Error(`Codex Run adapter cannot execute runtime ${runtime.id}`);
    }
    if (!runtime.capabilities.nativeResume) {
      throw new Error('Codex runtime is incompatible: native-resume capability is required by Agent Runs');
    }
  }
}
