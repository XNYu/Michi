/**
 * Turn Persistence Recipes
 *
 * Single source of truth for SQL templates and pure helper functions used by
 * the turn lifecycle (beginTurn / checkpointTurn / finalizeTurn).
 *
 * Both the main-thread `dbRepository.ts` and the off-thread
 * `dbWorkerThread.ts` import from here, eliminating schema drift between
 * the two execution environments.
 *
 * Rules:
 *  - NO database imports (`db.ts`, `node:sqlite`). Zero side effects.
 *  - Only string constants and pure functions.
 *  - If you change a SQL template here, both consumers get the fix for free.
 *
 * @module turnPersistence.recipes
 */

import { knownSubagentEnd, type DurableMessage, type DurableTurnSnapshot, type SubagentEnd } from 'michi-shared';

// ── Restart interruption ───────────────────────────────────────────────────
// A turn the process died under ends with this durable marker, whether the
// shutdown path finalized it or the next boot recovered it. The replay route
// and the hydration payload read the marker; the message is what a reader sees.

/** `turns.error` and the stream error `code` of a turn a restart cut short. */
export const BACKEND_RESTARTED_ERROR = 'backend_restarted';

/** The one sentence shown for such a turn, live or after a reload. */
export const BACKEND_RESTARTED_MESSAGE =
  'Michi restarted while this task was running. Review the partial output above, then resume.';

// ── SQL Templates ──────────────────────────────────────────────────────────
// Named so grep turns them up: search `TURN_SQL.` or `MESSAGE_SQL.`.

export const TURN_SQL = {
  /** Fetch a single turn by ID. */
  get: 'SELECT * FROM turns WHERE turn_id = ?',

  /** Insert a new active turn. Params: positional (7). */
  insert: `
    INSERT INTO turns (
      turn_id, node_id, user_message_id, assistant_message_id, status,
      last_seq, stop_reason, error, started_at, checkpoint_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL, ?, NULL, NULL, ?)`,

  /** Checkpoint progress. Params: positional (4). */
  updateCheckpoint: `
    UPDATE turns SET last_seq = ?, checkpoint_at = ?, updated_at = ? WHERE turn_id = ?`,

  /** Terminal finalization. Params: positional (9). */
  finalize: `
    UPDATE turns
    SET status = ?, last_seq = ?, stop_reason = ?, error = ?,
        checkpoint_at = ?, completed_at = ?, updated_at = ?, completion_seq = ?
    WHERE turn_id = ?`,
} as const;

export const MESSAGE_SQL = {
  /** Max sequence number for a node's messages. */
  maxSeq: 'SELECT COALESCE(MAX(seq), -1) AS seq FROM messages WHERE node_id = ?',

  /**
   * Upsert a message row.
   *
   * IMPORTANT: includes the `rev` column (sync L2 version number).
   * ON CONFLICT preserves existing non-null values via COALESCE so that a
   * sync-assigned rev is never clobbered by a turn-lifecycle write.
   *
   * Callers that don't have a rev should pass `rev: null` (or use the
   * default spread in dbRepository.saveMessage).
   */
  upsert: `
    INSERT INTO messages (id, node_id, role, content, blocks, tool_calls, metadata, seq, created_at, rev)
    VALUES (@id, @node_id, @role, @content, @blocks, @tool_calls, @metadata, @seq, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      content=excluded.content,
      blocks=COALESCE(excluded.blocks, messages.blocks),
      tool_calls=COALESCE(excluded.tool_calls, messages.tool_calls),
      metadata=COALESCE(excluded.metadata, messages.metadata),
      rev=COALESCE(excluded.rev, messages.rev)`,

  /** Update assistant message content + structured fields. Params: positional (6). */
  updateAssistant: `
    UPDATE messages
    SET content = ?, blocks = ?, tool_calls = ?, metadata = ?
    WHERE id = ? AND node_id = ? AND role = 'assistant'`,

  /** An assistant row's stored metadata. Params: positional (id, node_id). */
  getAssistantMetadata: `
    SELECT metadata FROM messages WHERE id = ? AND node_id = ? AND role = 'assistant'`,
} as const;

export const NODE_SQL = {
  /** Set title only if currently blank. */
  setTitleIfEmpty: `
    UPDATE nodes
    SET title = CASE WHEN title IS NULL OR TRIM(title) = '' THEN ? ELSE title END
    WHERE id = ?`,

  /** Update follow-ups. */
  setFollowUps:
    'UPDATE nodes SET follow_ups = ?, follow_ups_source_message_id = ? WHERE id = ?',

  /** Update streaming status + applied turn watermark. */
  setTurnProjection: `
    UPDATE nodes
    SET status = ?, last_applied_turn_id = ?, last_applied_seq = ?
    WHERE id = ?`,

  /** Read branch overview for journal append. */
  getBranchOverview:
    'SELECT branch_overview FROM nodes WHERE id = ?',

  /** Write updated branch overview. */
  setBranchOverview:
    'UPDATE nodes SET branch_overview = ? WHERE id = ?',

  /** Read composer draft for spawn-prompt outbox clearing. */
  getComposerDraft:
    'SELECT composer_draft FROM nodes WHERE id = ?',

  /** Clear composer draft (CAS: only if unchanged). */
  clearComposerDraft:
    'UPDATE nodes SET composer_draft = ? WHERE id = ? AND composer_draft = ?',

} as const;

// ── Pure Functions ─────────────────────────────────────────────────────────

/** Serialize a message's role-specific metadata to JSON for storage. */
export function durableMessageMetadata(message: DurableMessage): string | null {
  if (message.role === 'assistant') {
    const metadata = {
      ...message.metadata,
      // A turn that cleared its plan keeps `plan: []`, so a restored session
      // does not fall back to an older plan.
      ...(Array.isArray(message.plan) ? { plan: message.plan } : {}),
      ...(message.subagents?.length ? { subagents: message.subagents } : {}),
    };
    return Object.keys(metadata).length > 0 ? jsonOrNull(metadata) : null;
  }
  return message.metadata && Object.keys(message.metadata).length > 0
    ? jsonOrNull(message.metadata)
    : null;
}

/**
 * The ends a stored row's roster copies already record (shared
 * knownSubagentEnd): one per copy terminated with an outcome. Empty for
 * unreadable metadata or a row without a roster.
 */
export function storedSubagentEnds(raw: string | null): SubagentEnd[] {
  if (!raw) return [];
  let metadata: unknown;
  try { metadata = JSON.parse(raw); } catch { return []; }
  const roster = metadata && typeof metadata === 'object' ? (metadata as { subagents?: unknown }).subagents : undefined;
  if (!Array.isArray(roster)) return [];
  const ends: SubagentEnd[] = [];
  for (const entry of roster) {
    const end = knownSubagentEnd(entry);
    if (end) ends.push(end);
  }
  return ends;
}

/**
 * Verify that a replayed turn snapshot matches the durable identity of an
 * existing turn row. Throws if node, assistant, or user message IDs diverge.
 *
 * The loose property types (`unknown`) let this accept both the typed
 * `TurnRow` interface from dbRepository and the generic `Record<string,
 * SQLInputValue>` returned by the Worker thread's `cached().get()`.
 */
export function assertTurnIdentity(
  row: { node_id: unknown; assistant_message_id: unknown; user_message_id: unknown },
  snapshot: DurableTurnSnapshot,
): void {
  if (
    row.node_id !== snapshot.nodeId
    || row.assistant_message_id !== snapshot.assistantId
    || row.user_message_id !== (snapshot.userMessage?.id ?? null)
  ) {
    throw new Error(`turn ${snapshot.turnId} was replayed with different durable identity`);
  }
}

/**
 * Compute the terminal node status from a finalized snapshot.
 * Error snapshots → 'error'; everything else → 'idle'.
 */
export function terminalNodeStatus(snapshot: DurableTurnSnapshot): string {
  return snapshot.status === 'error' ? 'error' : 'idle';
}

// ── Internal helpers ───────────────────────────────────────────────────────

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}
