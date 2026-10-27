/**
 * The latest Meta agent restriction check per owner and toolset
 * (MetaAgentInfo.guard), stored in `meta` like the settings record. A result
 * belongs to the runtime profile its run resolved: once the profile resolved
 * now differs (a Meta agent settings change, or a followed global change), it
 * is stale and cleared on read.
 */

import type { MetaAgentGuardStatus, MetaAgentToolset } from 'michi-shared';
import { isMetaAgentGuardError, MetaAgentGuardError } from '../../agents/metaAgentGuard';
import { getDb } from '../db';

export const META_AGENT_TOOLSETS: readonly MetaAgentToolset[] = ['maintenance', 'chat'];

/** The profile a run resolved (MetaAgentResolvedRuntime or a scheduled run's profile). */
export interface MetaAgentRunProfile {
  runtimeId: string;
  providerId: string | null;
  modelId: string | null;
  reasoning: string | null;
}

/** What a failed check reported, without the toolset the caller already knows. */
export interface MetaAgentGuardFailure {
  runtimeId: string;
  unexpectedTools: string[];
  detail?: string;
}

interface StoredCheck {
  status: MetaAgentGuardStatus;
  profile: string;
}

export function metaAgentGuardOwnerKey(ownerUserId?: string | null): string {
  if (process.env.MICHI_CLOUD === '1') {
    if (!ownerUserId) throw new Error('Meta agent restriction checks require an authenticated owner');
    return `user:${ownerUserId}`;
  }
  return 'desktop';
}

const rowKey = (toolset: MetaAgentToolset, ownerUserId?: string | null) =>
  `meta_agent_guard:${metaAgentGuardOwnerKey(ownerUserId)}:${toolset}`;

const fingerprint = (profile: MetaAgentRunProfile) =>
  JSON.stringify([profile.runtimeId, profile.providerId ?? null, profile.modelId ?? null, profile.reasoning ?? null]);

/** Mirrors MetaAgentGuardError's message, which is all a runtime_error event or a stored turn error keeps. */
const GUARD_MESSAGE = /^Meta agent restriction check failed on ([^\s:()]+)(?:: ([\s\S]+?))?(?: \(([\s\S]*)\))?$/;

/**
 * The failure a Meta agent run stopped on, from the MetaAgentGuardError
 * itself or from its message (Claude reports a failed check as a
 * runtime_error event; a scheduled turn's error is stored as text).
 */
export function metaAgentGuardFailureOf(error: unknown): MetaAgentGuardFailure | null {
  if (isMetaAgentGuardError(error) && (error as MetaAgentGuardError).violation) {
    const { runtimeId, unexpectedTools, detail } = (error as MetaAgentGuardError).violation;
    return { runtimeId, unexpectedTools: [...unexpectedTools], ...(detail ? { detail } : {}) };
  }
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : null;
  const match = message ? GUARD_MESSAGE.exec(message) : null;
  if (!match) return null;
  return {
    runtimeId: match[1],
    unexpectedTools: match[2] ? match[2].split(', ') : [],
    ...(match[3] ? { detail: match[3] } : {}),
  };
}

export function metaAgentGuardStatusMessage(status: MetaAgentGuardStatus): string {
  return new MetaAgentGuardError({ runtimeId: status.runtimeId, toolset: status.toolset,
    unexpectedTools: status.unexpectedTools, ...(status.detail ? { detail: status.detail } : {}) }).message;
}

/**
 * Record a check: `failure` null means the run got past its check. A failure
 * reported by another runtime than the profile's is not this profile's result
 * and is dropped.
 */
export function recordMetaAgentGuardCheck(input: {
  toolset: MetaAgentToolset;
  profile: MetaAgentRunProfile;
  failure: MetaAgentGuardFailure | null;
  ownerUserId?: string | null;
  now?: number;
}): MetaAgentGuardStatus | null {
  if (input.failure && input.failure.runtimeId !== input.profile.runtimeId) return null;
  const status: MetaAgentGuardStatus = {
    state: input.failure ? 'failed' : 'ok',
    runtimeId: input.profile.runtimeId,
    toolset: input.toolset,
    unexpectedTools: input.failure ? [...input.failure.unexpectedTools] : [],
    ...(input.failure?.detail ? { detail: input.failure.detail } : {}),
    checkedAt: input.now ?? Date.now(),
  };
  const stored: StoredCheck = { status, profile: fingerprint(input.profile) };
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run(rowKey(input.toolset, input.ownerUserId), JSON.stringify(stored));
  return status;
}

function parseStored(raw: string): StoredCheck | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredCheck>;
    const status = value?.status;
    if (typeof value?.profile !== 'string' || !status || (status.state !== 'ok' && status.state !== 'failed')
      || typeof status.runtimeId !== 'string' || !Array.isArray(status.unexpectedTools) || typeof status.checkedAt !== 'number') return null;
    return value as StoredCheck;
  } catch {
    return null;
  }
}

/**
 * The latest check for a toolset, or null before the first one. `current`
 * resolves the profile a run starting now would use; it is only called when
 * a result is stored.
 */
export function getMetaAgentGuardStatus(
  toolset: MetaAgentToolset,
  current: () => MetaAgentRunProfile,
  ownerUserId?: string | null,
): MetaAgentGuardStatus | null {
  const key = rowKey(toolset, ownerUserId);
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  const stored = parseStored(row.value);
  if (!stored || stored.profile !== fingerprint(current())) {
    getDb().prepare('DELETE FROM meta WHERE key = ?').run(key);
    return null;
  }
  return { ...stored.status, toolset };
}

type RetryListener = (event: { ownerKey: string; toolsets: MetaAgentToolset[] }) => void;
const retryListeners = new Set<RetryListener>();

/** Called after a retry cleared stored results, so scheduled maintenance can try again at once. */
export function onMetaAgentGuardRetry(listener: RetryListener): () => void {
  retryListeners.add(listener);
  return () => { retryListeners.delete(listener); };
}

/** Clear the stored results so the next run checks again, then notify listeners. */
export function retryMetaAgentGuard(toolsets: readonly MetaAgentToolset[], ownerUserId?: string | null): void {
  const remove = getDb().prepare('DELETE FROM meta WHERE key = ?');
  for (const toolset of toolsets) remove.run(rowKey(toolset, ownerUserId));
  const event = { ownerKey: metaAgentGuardOwnerKey(ownerUserId), toolsets: [...toolsets] };
  for (const listener of retryListeners) listener(event);
}
