import type { ClaudeAdapterOptions } from 'michi-runtime/internal/adapters/claude/claudeAdapterOptions';
import { michiClaudeAdapterOptions } from '../../src/agents/michiClaudeOptions';
import { michiTestHost } from './michiTestHost';

/**
 * Options for a Claude runtime, session manager or session a test builds
 * directly: Michi's, as the factory passes them, over a new test host
 * (michiTestHost). No model catalog unless `overrides` names one, so
 * listModels keeps the static catalog. Each call returns a new object.
 */
export function claudeTestOptions(overrides: Partial<ClaudeAdapterOptions> = {}): ClaudeAdapterOptions {
  return { ...michiClaudeAdapterOptions(overrides.host ?? michiTestHost(), overrides.modelCatalog), ...overrides };
}
