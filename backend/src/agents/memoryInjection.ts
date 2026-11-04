import type { MemoryRecord } from 'michi-shared';
import { isAssistantWorkspace } from '../assistant/identity';
import { workspaceOwnerMatches } from '../services/agentOwner';
import { getWorkspace } from '../services/dbRepository';
import { log } from '../services/logger';
import { memoryOwnerId } from '../services/memory/memoryOwner';
import * as memoryService from '../services/memory/memoryService';
import { isRunOwner } from './ownerMapping';
import { MEMORY_BLOCK_BUDGET_CHARS, buildMemoryBlock, buildMemoryRetraction, type MemoryBlockEntry } from './preamble';
import type { AgentSession } from './types';

/**
 * Michi Memory in agent turns.
 *
 * chatHub asks prepare() before each turn it sends. A block (preamble.ts
 * buildMemoryBlock: the user's active preferences and conventions, then the
 * current workspace's, within MEMORY_BLOCK_BUDGET_CHARS) travels as
 * AgentTurnInput.memoryContext, which every adapter renders for the model
 * ahead of the Pages context and keeps out of its history: Claude, Codex,
 * Kiro, Kiro Crew and Antigravity (AcpAgentSession) and Pi. The stable system
 * prompt and the first-turn prefix are untouched.
 *
 * When a session gets one: its first turn, then only when memoryVersion for
 * its owner and workspace differs from the version last delivered to it.
 * Each block says it replaces earlier ones; when nothing is left to show (all
 * deleted, or memory turned off) after a block with entries was sent, a short
 * retraction is sent instead, and with nothing ever shown nothing is sent.
 * Delivery is tracked per live AgentSession object, so a session rebuilt or
 * resumed from history, forked or reloaded after a restart (always a new
 * object) gets a block on its first turn. A version counts as delivered only
 * when the turn ends neither cancelled nor failed; forget() drops it after a
 * compaction or a native command such as /clear, which may have taken the
 * block out of the runtime's context.
 *
 * Who gets one: turns of ordinary chats, including scheduled jobs and
 * cross-thread or Agent Run deliveries into them. The interactive Michi
 * assistant gets the user scope only (its hidden workspace has no memories
 * of its own). Pages maintenance turns (chatHub passes no request for them),
 * Agent Runs (a headless owner; their driver sends no host context) and
 * digests (sent outside chatHub) get none.
 *
 * Owner and workspace come from the turn chatHub runs, never from the model:
 * the owner the route or server caller gave it (cloud), or the local user
 * (desktop), as routes/memories.ts resolves it; the workspace from the chat
 * node's row, which must be the owner's.
 */

/** One turn chatHub is about to send to a live session. */
export interface MemoryTurnRequest {
  session: AgentSession;
  /** The turn's owner as the route or server caller gave it to chatHub. */
  ownerUserId: string | null;
  /** The chat node's workspace, from its stored row. */
  workspaceId: string | null;
}

/** A block for one turn. */
export interface PreparedMemoryContext {
  text: string;
  /** The turn ended neither cancelled nor failed: the session now holds this block. */
  delivered(): void;
}

interface MemoryScopeKey {
  ownerUserId: string;
  /** Null for the user scope alone. */
  workspaceId: string | null;
}

interface SessionMemoryState extends MemoryScopeKey {
  /** memoryVersion last delivered to the session; null when it may hold none. */
  version: number | null;
  /** A block with entries may be in the session's context. */
  holdsEntries: boolean;
  /** Bumped by forget(): a turn prepared before then delivers nothing. */
  epoch: number;
}

function memoryScope(ownerUserId: string | null, workspaceId: string | null): MemoryScopeKey | null {
  const owner = memoryOwnerId(ownerUserId);
  if (!owner || !workspaceId) return null;
  const workspace = getWorkspace(workspaceId);
  if (!workspace || !workspaceOwnerMatches(workspace.owner_user_id ?? null, owner)) return null;
  return { ownerUserId: owner, workspaceId: isAssistantWorkspace(workspaceId) ? null : workspaceId };
}

function blockEntry(record: MemoryRecord): MemoryBlockEntry {
  return { scope: record.scope.kind, kind: record.kind, body: record.body };
}

export class MemoryInjector {
  private readonly sessions = new WeakMap<AgentSession, SessionMemoryState>();

  /** The block this turn should carry, or null. Never throws: a failure only skips memory. */
  prepare(request: MemoryTurnRequest): PreparedMemoryContext | null {
    try {
      return this.prepareTurn(request);
    } catch (error) {
      log.warn('chat', 'Michi Memory block skipped', {
        sessionId: request.session.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The session may have lost its block (compaction, /clear): send it again next turn. */
  forget(session: AgentSession): void {
    const state = this.sessions.get(session);
    if (!state) return;
    state.version = null;
    state.epoch += 1;
  }

  private prepareTurn({ session, ownerUserId, workspaceId }: MemoryTurnRequest): PreparedMemoryContext | null {
    if (isRunOwner(session.owner)) return null;
    const scope = memoryScope(ownerUserId, workspaceId);
    if (!scope) return null;
    const caller = { ownerUserId: scope.ownerUserId };
    const version = memoryService.memoryVersion(caller, scope.workspaceId);
    let state = this.sessions.get(session);
    if (!state || state.ownerUserId !== scope.ownerUserId || state.workspaceId !== scope.workspaceId) {
      state = { ...scope, version: null, holdsEntries: state?.holdsEntries ?? false, epoch: (state?.epoch ?? 0) + 1 };
      this.sessions.set(session, state);
    }
    if (state.version === version) return null;

    const records = memoryService.pinnedPreferences(caller, scope.workspaceId, MEMORY_BLOCK_BUDGET_CHARS);
    const block = buildMemoryBlock(records.map(blockEntry), MEMORY_BLOCK_BUDGET_CHARS);
    if (!block && !state.holdsEntries) {
      state.version = version;
      return null;
    }
    const text = block
      || buildMemoryRetraction(memoryService.getMemorySettings(scope.ownerUserId).mode === 'off' ? 'off' : 'empty');
    if (block) state.holdsEntries = true;
    const prepared = state;
    const epoch = state.epoch;
    return {
      text,
      delivered: () => {
        if (this.sessions.get(session) !== prepared || prepared.epoch !== epoch) return;
        prepared.version = version;
        if (!block) prepared.holdsEntries = false;
      },
    };
  }
}

/** The process-wide injector chatHub uses. */
export const memoryInjector = new MemoryInjector();
