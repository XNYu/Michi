/**
 * Meta agent restriction check shared by every runtime adapter.
 *
 * A restricted Meta agent run (background maintenance or an explicit legacy
 * closed chat profile) may only see its closed toolset. Interactive Assistant
 * sessions have an identity marker without this restriction. Each adapter reports the tool names the runtime
 * actually exposed after session start, normalized to Michi tool names (or the
 * runtime's own built-in names), and fails the run when anything is outside the
 * allow-list. Never degrade or skip the check.
 */

import type { MetaAgentToolset } from 'michi-shared';
import type { RuntimeToolProfile } from './types';

export type { MetaAgentToolset };

export interface MetaAgentRuntimeAvailability {
  available: boolean;
  reason?: string;
}

/**
 * Runtimes that can host both Meta agent toolsets. A positive list: adding a
 * runtime needs a launch-time catalog check in its adapter first.
 */
const META_AGENT_RUNNABLE_RUNTIMES: ReadonlySet<string> = new Set(['claude', 'pi', 'codex', 'kiro']);

const META_AGENT_REFUSALS: Readonly<Record<string, string>> = {
  crew: 'The Meta agent does not run on Kiro Crew yet. Choose another runtime for it in Settings › Meta agent.',
};

/** Whether a runtime can host the Meta agent; the same answer for both toolsets. */
export function metaAgentRuntimeAvailability(runtimeId: string): MetaAgentRuntimeAvailability {
  if (META_AGENT_RUNNABLE_RUNTIMES.has(runtimeId)) return { available: true };
  return { available: false, reason: META_AGENT_REFUSALS[runtimeId] ?? `Runtime "${runtimeId}" is not approved for the Meta agent.` };
}

/** The toolset a profile runs with, or null for an ordinary session. */
export function metaAgentToolsetOf(profile: RuntimeToolProfile | null | undefined): MetaAgentToolset | null {
  if (!profile) return null;
  if (profile.metaAgentToolset) return profile.metaAgentToolset;
  if (profile.maintenance === true) return 'maintenance';
  if (profile.assistant === true && profile.restricted === true) return 'chat';
  return null;
}

export function isMetaAgentProfile(profile: RuntimeToolProfile | null | undefined): boolean {
  return metaAgentToolsetOf(profile) !== null;
}

export interface MetaAgentGuardViolation {
  runtimeId: string;
  toolset: MetaAgentToolset;
  /** Exposed by the runtime but not allowed. */
  unexpectedTools: string[];
  /** Short adapter-specific explanation (e.g. "tool catalog never published"). */
  detail?: string;
}

export const META_AGENT_GUARD_ERROR_CODE = 'meta_agent_guard_failed';

export class MetaAgentGuardError extends Error {
  readonly code = META_AGENT_GUARD_ERROR_CODE;
  constructor(readonly violation: MetaAgentGuardViolation) {
    const extra = violation.unexpectedTools.length ? `: ${violation.unexpectedTools.join(', ')}` : '';
    super(`Meta agent restriction check failed on ${violation.runtimeId}${extra}${violation.detail ? ` (${violation.detail})` : ''}`);
    this.name = 'MetaAgentGuardError';
  }
}

export function isMetaAgentGuardError(error: unknown): error is MetaAgentGuardError {
  return error instanceof MetaAgentGuardError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === META_AGENT_GUARD_ERROR_CODE);
}

/**
 * Compare the observed catalog with the allow-list. `extraAllowed` holds the
 * runtime's unremovable built-ins that neither edit files nor run commands.
 * Returns null when the catalog is within bounds.
 */
export function checkMetaAgentToolCatalog(input: {
  runtimeId: string;
  toolset: MetaAgentToolset;
  observed: readonly string[];
  allowed: readonly string[];
  extraAllowed?: readonly string[];
}): MetaAgentGuardViolation | null {
  const permitted = new Set([...input.allowed, ...(input.extraAllowed ?? [])]);
  const unexpectedTools = [...new Set(input.observed)].filter((name) => !permitted.has(name)).sort();
  return unexpectedTools.length ? { runtimeId: input.runtimeId, toolset: input.toolset, unexpectedTools } : null;
}

/**
 * Check a Meta agent session's observed catalog against its profile's
 * allow-list and throw MetaAgentGuardError on anything extra. A profile
 * without an allow-list permits nothing.
 */
export function assertMetaAgentToolCatalog(input: {
  runtimeId: string;
  profile: RuntimeToolProfile | null | undefined;
  observed: readonly string[];
  extraAllowed?: readonly string[];
}): void {
  const toolset = metaAgentToolsetOf(input.profile);
  if (!toolset) throw new Error('assertMetaAgentToolCatalog needs a Meta agent profile');
  const violation = checkMetaAgentToolCatalog({
    runtimeId: input.runtimeId,
    toolset,
    observed: input.observed,
    allowed: input.profile?.allowedToolNames ?? [],
    extraAllowed: input.extraAllowed,
  });
  if (violation) throw new MetaAgentGuardError(violation);
}

/** The failure for a runtime that never reported what it exposes. */
export function metaAgentCatalogUnavailable(runtimeId: string, toolset: MetaAgentToolset, detail: string): MetaAgentGuardError {
  return new MetaAgentGuardError({ runtimeId, toolset, unexpectedTools: [], detail });
}
