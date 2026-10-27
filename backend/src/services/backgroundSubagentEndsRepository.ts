import {
  endBackgroundSubagents,
  isBackgroundSubagentPending,
  knownSubagentEnd,
  subagentEndOf,
  SUBAGENT_RESTARTED_ERROR,
  type SubagentEnd,
  type SubagentInfo,
} from 'michi-shared';
import { workspaceOwnerMatches } from './agentOwner';
import { getDb, isDbOpen, runInTransaction } from './db';

/**
 * Stored ends of background subagents that no turn will report (see
 * shared endBackgroundSubagents): a background agent's launch message and
 * every later message that carried it keep a roster copy that waits for an
 * outcome. When the agent process that ran it ends first, nothing would
 * ever give those copies one.
 *
 * Every assistant row whose roster holds a background entry contains this
 * text: rosters are written with JSON.stringify (durableMessageMetadata),
 * which emits no spaces. Rows without it hold none and are not read.
 */
const BACKGROUND_ENTRY = '%"background":true%';

/** Runtimes whose background agents run inside a process this backend owns (Claude CLI, codex app-server). */
const PROCESS_BOUND_SOURCES: ReadonlySet<string> = new Set(['claude', 'codex']);

interface StoredRoster {
  metadata: Record<string, unknown>;
  /**
   * As stored: endBackgroundSubagents skips anything malformed, so fields
   * it does not touch are written back unchanged.
   */
  roster: SubagentInfo[];
}

/** A row's metadata and its non-empty roster; null when unreadable or it has none. */
function storedRoster(raw: string | null): StoredRoster | null {
  if (!raw) return null;
  let metadata: unknown;
  try { metadata = JSON.parse(raw); } catch { return null; }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const roster = (metadata as { subagents?: unknown }).subagents;
  if (!Array.isArray(roster) || roster.length === 0) return null;
  return { metadata: metadata as Record<string, unknown>, roster: roster as SubagentInfo[] };
}

/** `stored` with `ends` applied to its roster, or null when nothing changed. */
function endedMetadata(stored: StoredRoster, ends: readonly SubagentEnd[]): { metadata: string; changed: number } | null {
  if (ends.length === 0) return null;
  const next = endBackgroundSubagents(stored.roster, ends);
  if (next === stored.roster) return null;
  return {
    metadata: JSON.stringify({ ...stored.metadata, subagents: next }),
    changed: next.filter((entry, index) => entry !== stored.roster[index]).length,
  };
}

/** A copy this sweep ends: background, waiting for an outcome, run inside a process this backend owned. */
function isOrphanCandidate(entry: SubagentInfo): boolean {
  return !!entry && typeof entry === 'object' && typeof entry.sessionId === 'string'
    && isBackgroundSubagentPending(entry) && PROCESS_BOUND_SOURCES.has(entry.source ?? '');
}

export interface NodeSubagentEnds {
  /** The node's workspace, from the database. */
  workspaceId: string;
  /** Assistant messages whose roster changed. */
  messageIds: string[];
}

/**
 * Record `ends` on the stored rosters of one chat node, in one transaction:
 * its assistant messages' copies that still wait for an outcome. Applying
 * the same ends again changes nothing. Null, and nothing written, when the
 * database is closed (shutdown), the node does not exist or was purged, or
 * its workspace is not `ownerUserId`'s.
 */
export function endNodeBackgroundSubagents(
  ownerUserId: string,
  nodeId: string,
  ends: readonly SubagentEnd[],
): NodeSubagentEnds | null {
  // getDb() would reopen a database the shutdown already closed.
  if (!isDbOpen()) return null;
  return runInTransaction(() => {
    const db = getDb();
    const node = db.prepare(`
      SELECT n.workspace_id AS workspace_id, w.owner_user_id AS owner_user_id
      FROM nodes n JOIN workspaces w ON w.id = n.workspace_id
      WHERE n.id = ? AND n.purged_at IS NULL
    `).get(nodeId) as { workspace_id: string; owner_user_id: string | null } | undefined;
    if (!node || !workspaceOwnerMatches(node.owner_user_id, ownerUserId)) return null;
    const result: NodeSubagentEnds = { workspaceId: node.workspace_id, messageIds: [] };
    if (ends.length === 0) return result;
    const rows = db.prepare(`
      SELECT id, metadata FROM messages
      WHERE node_id = ? AND role = 'assistant' AND metadata LIKE ?
      ORDER BY seq
    `).all(nodeId, BACKGROUND_ENTRY) as Array<{ id: string; metadata: string | null }>;
    const update = db.prepare(`UPDATE messages SET metadata = ? WHERE id = ? AND node_id = ? AND role = 'assistant'`);
    for (const row of rows) {
      const stored = storedRoster(row.metadata);
      const ended = stored && endedMetadata(stored, ends);
      if (!ended) continue;
      update.run(ended.metadata, row.id, nodeId);
      result.messageIds.push(row.id);
    }
    return result;
  });
}

export interface StartupSubagentEnds {
  messages: number;
  subagents: number;
}

/** `meta` key: when the last startup sweep ran (ms). */
export const BACKGROUND_SWEEP_META_KEY = 'background_subagents_swept_at';
/**
 * No build before this wrote a background roster entry (SubagentInfo.background
 * is from October 2026), so a first sweep reads no older turns.
 */
export const BACKGROUND_ROSTERS_SINCE_MS = Date.UTC(2026, 9, 1);
/** Read turns from this long before the last sweep: a clock set back must not hide one. */
export const BACKGROUND_SWEEP_MARGIN_MS = 24 * 60 * 60_000;

/**
 * Backend startup, before any agent session starts: no agent process
 * survives a restart (Claude CLI and codex app-server children are this
 * backend's; Kiro and Crew rosters never mark an agent background), so
 * every stored Claude or Codex background entry still waiting for an
 * outcome gets one. An agent that reported back in another of its node's
 * messages takes that outcome (with its end time and result); the rest
 * are recorded as stopped with `error`, and with no end time, since when
 * they ended is unknown. One transaction; idempotent.
 *
 * Bounded: rosters are written by turns (begin, checkpoint, finalize all
 * stamp turns.updated_at), so only the assistant rows of turns updated
 * since the previous sweep (less BACKGROUND_SWEEP_MARGIN_MS) are read,
 * since BACKGROUND_ROSTERS_SINCE_MS on the first. Rows of turns still
 * active (kept for Agent Run delivery) are left to that turn and read
 * again once it is updated. Rows without a turn (imported) are not read;
 * the renderer still shows their agents as interrupted (untrackedSubagent).
 */
export function endOrphanedBackgroundSubagents(error = SUBAGENT_RESTARTED_ERROR, now = Date.now()): StartupSubagentEnds {
  if (!isDbOpen()) return { messages: 0, subagents: 0 };
  return runInTransaction(() => {
    const db = getDb();
    const swept = Number((db.prepare('SELECT value FROM meta WHERE key = ?').get(BACKGROUND_SWEEP_META_KEY) as { value: string } | undefined)?.value);
    const since = Number.isFinite(swept) && swept > 0 ? swept - BACKGROUND_SWEEP_MARGIN_MS : BACKGROUND_ROSTERS_SINCE_MS;
    // CROSS JOIN keeps turns as the outer loop (SQLite does not reorder it):
    // the turns rows are small, and only their messages are read by id.
    // A plain JOIN lets the planner scan every message's metadata instead.
    const rows = db.prepare(`
      SELECT m.id AS id, m.node_id AS node_id, m.metadata AS metadata
      FROM turns t CROSS JOIN messages m ON m.id = t.assistant_message_id
      WHERE t.updated_at >= ? AND t.status != 'active' AND m.role = 'assistant' AND m.metadata LIKE ?
    `).all(since, BACKGROUND_ENTRY) as Array<{ id: string; node_id: string; metadata: string | null }>;
    const update = db.prepare(`UPDATE messages SET metadata = ? WHERE id = ? AND node_id = ? AND role = 'assistant'`);
    const nodeRows = db.prepare(`
      SELECT metadata FROM messages
      WHERE node_id = ? AND role = 'assistant' AND metadata LIKE ?
      ORDER BY seq
    `);
    const reportedByNode = new Map<string, Map<string, SubagentEnd>>();
    /** The outcomes a node's agents already reported, on any of its rows (the newest copy wins). */
    const reportedIn = (nodeId: string): Map<string, SubagentEnd> => {
      let reported = reportedByNode.get(nodeId);
      if (reported) return reported;
      reported = new Map();
      for (const { metadata } of nodeRows.all(nodeId, BACKGROUND_ENTRY) as Array<{ metadata: string | null }>) {
        for (const entry of storedRoster(metadata)?.roster ?? []) {
          const end = knownSubagentEnd(entry);
          if (end) reported.set(end.sessionId, end);
        }
      }
      reportedByNode.set(nodeId, reported);
      return reported;
    };
    const counts: StartupSubagentEnds = { messages: 0, subagents: 0 };
    for (const row of rows) {
      const stored = storedRoster(row.metadata);
      const candidates = stored?.roster.filter(isOrphanCandidate) ?? [];
      if (!stored || candidates.length === 0) continue;
      // A pending copy is the normal state of every message but the one
      // that carries the agent's outcome (Claude reports it in a later,
      // self-initiated turn), so an agent that reported back anywhere in
      // the node takes that outcome; only the rest were cut off by the restart.
      const reported = reportedIn(row.node_id);
      const ends = candidates.map((entry) => reported.get(entry.sessionId) ?? subagentEndOf(entry, error));
      const ended = endedMetadata(stored, ends);
      if (!ended) continue;
      update.run(ended.metadata, row.id, row.node_id);
      counts.messages += 1;
      counts.subagents += ended.changed;
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(BACKGROUND_SWEEP_META_KEY, String(now));
    return counts;
  });
}
