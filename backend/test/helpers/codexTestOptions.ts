import type { CodexAdapterOptions } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import { michiCodexHostText } from '../../src/agents/michiCodexOptions';
import { michiTestHost } from './michiTestHost';

/**
 * Options for a Codex runtime a test builds directly: a new test host
 * (michiTestHost) unless `overrides` names one, and Michi's wording
 * (michiCodexHostText), as the factory passes it. Unlike the factory's
 * codexAdapterOptions it reads no environment, so limits and timeouts keep
 * the adapter's defaults. Each call returns a new object.
 */
export function codexTestOptions(overrides: Partial<CodexAdapterOptions> = {}): CodexAdapterOptions {
  return { host: overrides.host ?? michiTestHost(), hostText: michiCodexHostText(), ...overrides };
}
