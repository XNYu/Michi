import type { RuntimeRunAdapter } from './runtimeRunAdapter';

// ---------------------------------------------------------------------------
// Runtime Run Adapter Registry
// ---------------------------------------------------------------------------

/**
 * Single authoritative registry for all Run-compatible runtime adapters.
 *
 * Three consumers share one registry instance so they can never disagree
 * about which runtimes support Agent Runs:
 *
 * 1. **RuntimeRunExecutor** — looks up the adapter to start/resume an Attempt.
 * 2. **Definition readiness** — checks both a registered `AgentRuntime` AND
 *    a registered `RuntimeRunAdapter` before allowing enable.
 * 3. **Capability catalog** — reports Run-support metadata to the frontend.
 *
 * Adapters are injected at boot (typically in `AgentRunAssembly`) and the
 * registry is thereafter immutable for the lifetime of the process.
 */
export class RuntimeRunAdapterRegistry {
  private readonly adapters = new Map<string, RuntimeRunAdapter>();

  constructor(adapters: readonly RuntimeRunAdapter[] = []) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.runtimeId)) {
        throw new Error(`Duplicate Run adapter for runtime ${adapter.runtimeId}`);
      }
      this.adapters.set(adapter.runtimeId, adapter);
    }
  }

  /** Returns the adapter for a runtime id, or undefined when not registered. */
  get(runtimeId: string): RuntimeRunAdapter | undefined {
    return this.adapters.get(runtimeId);
  }

  /** True when a Run adapter is registered for the given runtime id. */
  has(runtimeId: string): boolean {
    return this.adapters.has(runtimeId);
  }

  /** All registered adapter runtime ids, in registration order. */
  supportedRuntimeIds(): readonly string[] {
    return [...this.adapters.keys()];
  }

  /** All registered adapters, in registration order. */
  all(): readonly RuntimeRunAdapter[] {
    return [...this.adapters.values()];
  }
}
