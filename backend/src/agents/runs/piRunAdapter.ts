import type { AgentRuntime } from '../types';
import type { NativeToolMode, RuntimeRunAdapter, SteeringStrategy } from './runtimeRunAdapter';

export class PiRunAdapter implements RuntimeRunAdapter {
  readonly runtimeId = 'pi';
  readonly supportsNativeResume = false;
  readonly nativeToolMode: NativeToolMode = 'allowlist';
  readonly steering: SteeringStrategy = 'native';

  assertCompatible(runtime: AgentRuntime): void {
    if (runtime.id !== this.runtimeId) throw new Error(`Pi Run adapter cannot execute runtime ${runtime.id}`);
    if (!runtime.capabilities.models || !runtime.capabilities.reasoning) {
      throw new Error('Pi runtime does not expose the model/reasoning capabilities required by Agent Runs');
    }
  }
}
