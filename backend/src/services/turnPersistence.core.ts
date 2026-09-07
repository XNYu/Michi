/**
 * Turn Persistence Core
 *
 * The single source of truth for turn lifecycle business logic
 * (beginTurn / checkpointTurn / finalizeTurn). This module contains
 * ZERO database imports — all DB access goes through the injected
 * `DbPrimitives` interface, so the same logic runs identically on
 * the main Express thread and the database Worker thread.
 *
 * Design decisions (from the prior analysis):
 *  - DbPrimitives.run() returns `{ changes: number }` (not bigint).
 *    Each adapter does `Number(r.changes)` exactly once.
 *  - Each top-level function wraps itself in `db.runInTransaction()`.
 *    Neither adapter implements idempotent nesting — the Worker is
 *    single-threaded serial, and the main thread has no nesting today.
 *  - Pure helpers (SQL constants, assertTurnIdentity, etc.) stay in
 *    `turnPersistence.recipes.ts`. This file imports them.
 *
 * @module turnPersistence.core
 */

import {
  appendBranchOverviewEntry,
  checkpointTurnContent,
  parseBranchOverviewEntries,
  serializeBranchOverviewEntries,
  type DurableMessage,
  type DurableTurnSnapshot,
} from 'michi-shared';

import {
  assertTurnIdentity,
  durableMessageMetadata,
  MESSAGE_SQL,
  NODE_SQL,
  terminalNodeStatus,
  TURN_SQL,
} from './turnPersistence.recipes';

// ── DbPrimitives — the kitchen interface ───────────────────────────────────

/**
 * Minimal database operations needed by the turn lifecycle.
 *
 * Each execution environment (main thread / Worker) provides its own
 * implementation. The contract:
 *  - `run()` returns `{ changes: number }` — the adapter coerces bigint.
 *  - `runInTransaction()` uses simple BEGIN/COMMIT; no idempotent nesting.
 *  - Statement caching is the adapter's concern, invisible to core.
 */
export interface DbPrimitives {
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
  run(sql: string, ...params: unknown[]): { changes: number };
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  runNamed(sql: string, params: Record<string, unknown>): void;
  runInTransaction<T>(fn: () => T): T;
}

// ── Turn row type (DB-agnostic) ────────────────────────────────────────────

/** A plain-object turn row as returned by `SELECT * FROM turns`. */
export type CoreTurnRow = Record<string, unknown>;

// ── Internal helpers ───────────────────────────────────────────────────────

function getTurnRow(db: DbPrimitives, turnId: string): CoreTurnRow | null {
  return db.get<CoreTurnRow>(TURN_SQL.get, turnId) ?? null;
}

function clearPendingSpawnPromptOutbox(db: DbPrimitives, nodeId: string): void {
  const row = db.get<{ composer_draft?: string | null }>(NODE_SQL.getComposerDraft, nodeId);
  const raw = row?.composer_draft;
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed?.__michiPendingSpawnPrompt !== 'string') return;
  } catch {
    return;
  }
  db.run(NODE_SQL.clearComposerDraft, nodeId, raw);
}

function saveMessageRow(
  db: DbPrimitives,
  msg: {
    id: string;
    node_id: string;
    role: string;
    content: string;
    blocks: string | null;
    tool_calls: string | null;
    metadata: string | null;
    seq: number;
    created_at: number;
    rev?: string | null;
  },
): void {
  db.runNamed(MESSAGE_SQL.upsert, { rev: null, ...msg } as Record<string, unknown>);
}

function writeAssistantSnapshot(
  db: DbPrimitives,
  snapshot: DurableTurnSnapshot,
  content = snapshot.assistantMessage.content,
): void {
  const message = snapshot.assistantMessage;
  const result = db.run(
    MESSAGE_SQL.updateAssistant,
    content,
    message.blocks.length > 0 ? JSON.stringify(message.blocks) : null,
    message.toolCalls.length > 0 ? JSON.stringify(message.toolCalls) : null,
    durableMessageMetadata(message),
    message.id,
    snapshot.nodeId,
  );
  if (result.changes !== 1) {
    throw new Error(`assistant message ${message.id} is missing for turn ${snapshot.turnId}`);
  }
}

export function appendBranchOverviewJournal(db: DbPrimitives, nodeId: string, text: string): void {
  const row = db.get<{ branch_overview?: string | null }>(NODE_SQL.getBranchOverview, nodeId);
  if (!row) return;
  const entries = parseBranchOverviewEntries(row.branch_overview ?? null);
  const next = appendBranchOverviewEntry(entries, text, Date.now());
  if (next === entries) return;
  db.run(NODE_SQL.setBranchOverview, serializeBranchOverviewEntries(next), nodeId);
}

function writeTurnNodeProjection(
  db: DbPrimitives,
  snapshot: DurableTurnSnapshot,
  terminal: boolean,
): void {
  const metadata = snapshot.nodeMetadata;
  if (metadata.title) {
    db.run(NODE_SQL.setTitleIfEmpty, metadata.title, snapshot.nodeId);
  }
  if (metadata.followUps !== undefined) {
    db.run(NODE_SQL.setFollowUps, JSON.stringify(metadata.followUps), snapshot.assistantId, snapshot.nodeId);
  }
  if (terminal && metadata.branchOverview) {
    appendBranchOverviewJournal(db, snapshot.nodeId, metadata.branchOverview);
  }
  db.run(
    NODE_SQL.setTurnProjection,
    terminal ? terminalNodeStatus(snapshot) : 'streaming',
    snapshot.turnId,
    snapshot.lastAppliedSeq,
    snapshot.nodeId,
  );
}

// ── Public core functions ──────────────────────────────────────────────────

/**
 * Insert deterministic provisional messages and the turn receipt atomically.
 * Idempotent: replaying the same turnId returns the existing row.
 */
export function coreBeginTurn(db: DbPrimitives, snapshot: DurableTurnSnapshot): CoreTurnRow {
  return db.runInTransaction(() => {
    const existing = getTurnRow(db, snapshot.turnId);
    if (existing) {
      assertTurnIdentity(
        existing as { node_id: unknown; assistant_message_id: unknown; user_message_id: unknown },
        snapshot,
      );
      clearPendingSpawnPromptOutbox(db, snapshot.nodeId);
      return existing;
    }

    const node = db.get<{ id: string; workspace_id: string; purged_at: number | null }>(
      'SELECT id, workspace_id, purged_at FROM nodes WHERE id = ? AND purged_at IS NULL',
      snapshot.nodeId,
    );
    if (!node) throw new Error(`node ${snapshot.nodeId} does not exist`);
    if (node.workspace_id !== snapshot.workspaceId) {
      throw new Error(`node ${snapshot.nodeId} does not belong to workspace ${snapshot.workspaceId}`);
    }

    clearPendingSpawnPromptOutbox(db, snapshot.nodeId);

    const max = db.get<{ seq: number }>(MESSAGE_SQL.maxSeq, snapshot.nodeId);
    let seq = (max?.seq ?? -1) + 1;

    if (snapshot.userMessage) {
      saveMessageRow(db, {
        id: snapshot.userMessage.id,
        node_id: snapshot.nodeId,
        role: 'user',
        content: snapshot.userMessage.content,
        blocks: null,
        tool_calls: null,
        metadata: durableMessageMetadata(snapshot.userMessage),
        seq: seq++,
        created_at: snapshot.userMessage.createdAt,
      });
    }

    saveMessageRow(db, {
      id: snapshot.assistantMessage.id,
      node_id: snapshot.nodeId,
      role: 'assistant',
      content: snapshot.assistantMessage.content,
      blocks: null,
      tool_calls: null,
      metadata: durableMessageMetadata(snapshot.assistantMessage),
      seq,
      created_at: snapshot.assistantMessage.createdAt,
    });

    const now = Date.now();
    db.run(
      TURN_SQL.insert,
      snapshot.turnId,
      snapshot.nodeId,
      snapshot.userMessage?.id ?? null,
      snapshot.assistantId,
      snapshot.lastAppliedSeq,
      snapshot.startedAt,
      now,
    );

    writeTurnNodeProjection(db, snapshot, false);
    return getTurnRow(db, snapshot.turnId)!;
  });
}

/**
 * Persist a bounded partial snapshot without marking the turn terminal.
 * No-op if the snapshot's seq is not ahead of the stored watermark.
 */
export function coreCheckpointTurn(db: DbPrimitives, snapshot: DurableTurnSnapshot): CoreTurnRow {
  return db.runInTransaction(() => {
    const row = getTurnRow(db, snapshot.turnId);
    if (!row) throw new Error(`turn ${snapshot.turnId} has not begun`);
    assertTurnIdentity(
      row as { node_id: unknown; assistant_message_id: unknown; user_message_id: unknown },
      snapshot,
    );
    if (row.status !== 'active' || snapshot.lastAppliedSeq < (row.last_seq as number)) return row;

    writeAssistantSnapshot(db, snapshot, checkpointTurnContent(snapshot));
    writeTurnNodeProjection(db, snapshot, false);

    const now = Date.now();
    db.run(TURN_SQL.updateCheckpoint, snapshot.lastAppliedSeq, now, now, snapshot.turnId);
    return getTurnRow(db, snapshot.turnId)!;
  });
}

/**
 * Atomically materialize the canonical terminal snapshot.
 * Throws if the snapshot is still 'active' (caller must set a terminal status).
 */
export function coreFinalizeTurn(db: DbPrimitives, snapshot: DurableTurnSnapshot): CoreTurnRow {
  if (snapshot.status === 'active') {
    throw new Error(`turn ${snapshot.turnId} cannot finalize while active`);
  }
  return db.runInTransaction(() => {
    const row = getTurnRow(db, snapshot.turnId);
    if (!row) throw new Error(`turn ${snapshot.turnId} has not begun`);
    assertTurnIdentity(
      row as { node_id: unknown; assistant_message_id: unknown; user_message_id: unknown },
      snapshot,
    );
    if (row.status !== 'active') {
      if (row.status !== snapshot.status) {
        throw new Error(`turn ${snapshot.turnId} is already finalized as ${row.status}`);
      }
      return row;
    }

    writeAssistantSnapshot(db, snapshot);
    writeTurnNodeProjection(db, snapshot, true);

    const now = Date.now();
    const completedAt = snapshot.completedAt ?? now;
    db.run(
      TURN_SQL.finalize,
      snapshot.status,
      snapshot.lastAppliedSeq,
      snapshot.stopReason ?? null,
      snapshot.error ?? null,
      now,
      completedAt,
      now,
      snapshot.turnId,
    );
    return getTurnRow(db, snapshot.turnId)!;
  });
}
