import type { AgentRuntime } from '../types';
import { PI_RUN } from '../pi/piDescriptor';
import type { NativeToolMode, RuntimeRunAdapter, SteeringStrategy } from './runtimeRunAdapter';

/** Run behavior comes from the Pi descriptor's run facet. */
export class PiRunAdapter implements RuntimeRunAdapter {
  readonly runtimeId = 'pi';
  readonly supportsNativeResume = PI_RUN.supportsNativeResume;
  readonly nativeToolMode: NativeToolMode = PI_RUN.toolMode;
  readonly steering: SteeringStrategy = PI_RUN.steering;
  readonly immediateSteering = PI_RUN.immediateSteering;

  assertCompatible(runtime: AgentRuntime): void {
    if (runtime.id !== this.runtimeId) throw new Error(`Pi Run adapter cannot execute runtime ${runtime.id}`);
    if (!runtime.capabilities.models || !runtime.capabilities.reasoning) {
      throw new Error('Pi runtime does not expose the model/reasoning capabilities required by Agent Runs');
    }
  }
}
