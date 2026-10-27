import type { AgentRuntime } from '../types';
import { CLAUDE_RUN } from 'michi-runtime/internal/adapters/claude/claudeDescriptor';
import type { NativeToolMode, RuntimeRunAdapter, SteeringStrategy } from './runtimeRunAdapter';

/** Run behavior comes from the Claude descriptor's run facet. */
export class ClaudeRunAdapter implements RuntimeRunAdapter {
  readonly runtimeId = 'claude';
  readonly supportsNativeResume = CLAUDE_RUN.supportsNativeResume;
  readonly nativeToolMode: NativeToolMode = CLAUDE_RUN.toolMode;
  readonly steering: SteeringStrategy = CLAUDE_RUN.steering;
  // No immediateSteering: it only qualifies native steering, which Claude does not use.

  assertCompatible(runtime: AgentRuntime): void {
    if (runtime.id !== this.runtimeId) throw new Error(`Claude Run adapter cannot execute runtime ${runtime.id}`);
    if (!runtime.capabilities.models || !runtime.capabilities.nativeResume) {
      throw new Error('Claude runtime does not expose the model/native-resume capabilities required by Agent Runs');
    }
  }
}
