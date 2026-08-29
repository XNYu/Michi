import { MAX_RUN_TTL_MS, MIN_RUN_TTL_MS, type AgentRunDtoV1 } from 'michi-shared';
import { isTerminalRunStatus } from './agentRunStateMachine';
import type { AgentRunRepositoryPort, AgentRunResourceCleaner } from './ports';

export function deriveRunExpiresAt(input: {
  now: number;
  invocationMode: 'delegated' | 'manual';
  requestedTtlMs: number | null;
  definitionDefaultTtlMs: number | null;
  platformMaxTtlMs: number;
}): number | null {
  const ceiling = Math.min(input.platformMaxTtlMs, MAX_RUN_TTL_MS);
  const baseline = input.definitionDefaultTtlMs;
  let ttl: number | null;
  if (input.invocationMode === 'manual') {
    ttl = input.requestedTtlMs ?? baseline;
  } else if (baseline === null) {
    ttl = input.requestedTtlMs;
  } else {
    ttl = input.requestedTtlMs === null ? baseline : Math.min(baseline, input.requestedTtlMs);
  }
  if (ttl === null) return null;
  if (!Number.isSafeInteger(ttl) || ttl < MIN_RUN_TTL_MS || ttl > ceiling) throw new Error('Run TTL exceeds retention policy');
  return input.now + ttl;
}

export class AgentRunRetention {
  constructor(private readonly repository: AgentRunRepositoryPort, private readonly cleaner: AgentRunResourceCleaner) {}

  async cleanupExpired(ownerUserId: string, workspaceId: string, now: number, limit = 100): Promise<string[]> {
    const removed: string[] = [];
    for (const run of this.repository.listTtlCandidates(ownerUserId, workspaceId, now, limit)) {
      if (!isTerminalRunStatus(run.status)) continue;
      this.repository.archiveRun(ownerUserId, run.id, now);
      await this.cleaner.cleanup(run.id);
      if (this.repository.deleteRun(ownerUserId, run.id)) removed.push(run.id);
    }
    return removed;
  }

  shouldDefer(run: AgentRunDtoV1, now: number): boolean {
    return run.expiresAt !== null && run.expiresAt <= now && !isTerminalRunStatus(run.status);
  }
}
