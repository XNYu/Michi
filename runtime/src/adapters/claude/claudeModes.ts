import type { SessionMode } from '../../contract/types';

/**
 * Claude chat work modes, shown where Kiro lists its agents. A work mode is
 * separate from the host's approval policy (Ask / Trust / YOLO): Plan sets
 * the SDK permission mode to 'plan'; Default uses the mode the approval
 * policy maps to ('default', or 'bypassPermissions' for YOLO).
 */
export type ClaudeWorkMode = 'default' | 'plan';

export const CLAUDE_MODES: readonly (SessionMode & { id: ClaudeWorkMode; label: string; description: string })[] = Object.freeze([
  { id: 'default', label: 'Default', description: 'Claude works under the chat\'s approval mode' },
  { id: 'plan', label: 'Plan', description: 'Claude explores read-only and proposes a plan; you approve it before it makes changes' },
]);

export function isClaudeWorkMode(value: unknown): value is ClaudeWorkMode {
  return value === 'default' || value === 'plan';
}
