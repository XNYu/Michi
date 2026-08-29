import type { AgentRuntime } from '../types';
import type { NativeToolMode, RuntimeRunAdapter, SteeringStrategy } from './runtimeRunAdapter';

export class ClaudeRunAdapter implements RuntimeRunAdapter {
  readonly runtimeId = 'claude';
  readonly supportsNativeResume = true;
  readonly nativeToolMode: NativeToolMode = 'allowlist';
  readonly steering: SteeringStrategy = 'native';

  assertCompatible(runtime: AgentRuntime): void {
    if (runtime.id !== this.runtimeId) throw new Error(`Claude Run adapter cannot execute runtime ${runtime.id}`);
    if (!runtime.capabilities.models || !runtime.capabilities.nativeResume) {
      throw new Error('Claude runtime does not expose the model/native-resume capabilities required by Agent Runs');
    }
  }
}
