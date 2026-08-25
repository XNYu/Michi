import { getDb } from "./db";

export interface HarnessJournalEntry {
  nodeId: string;
  turnId: string;
  seq: number;
  event: string;
  source?: string;
  confidence?: string;
  nativeMethod?: string;
  payload: string;
  createdAt: number;
}

export interface HarnessJournal {
  append(entry: HarnessJournalEntry): void;
}

export function createSqliteHarnessJournal(): HarnessJournal {
  return {
    append(entry) {
      const db = getDb();
      db.prepare(`
        INSERT OR IGNORE INTO harness_events
          (node_id, turn_id, seq, event, source, confidence, native_method, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.nodeId,
        entry.turnId,
        entry.seq,
        entry.event,
        entry.source ?? null,
        entry.confidence ?? null,
        entry.nativeMethod ?? null,
        entry.payload,
        entry.createdAt,
      );
    },
  };
}

export function listHarnessEvents(nodeId: string, turnId: string): HarnessJournalEntry[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT node_id, turn_id, seq, event, source, confidence, native_method, payload, created_at
    FROM harness_events
    WHERE node_id = ? AND turn_id = ?
    ORDER BY seq ASC
  `).all(nodeId, turnId) as Array<{
    node_id: string;
    turn_id: string;
    seq: number;
    event: string;
    source: string | null;
    confidence: string | null;
    native_method: string | null;
    payload: string;
    created_at: number;
  }>;
  return rows.map((row) => ({
    nodeId: row.node_id,
    turnId: row.turn_id,
    seq: row.seq,
    event: row.event,
    source: row.source ?? undefined,
    confidence: row.confidence ?? undefined,
    nativeMethod: row.native_method ?? undefined,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

export class MemoryHarnessJournal implements HarnessJournal {
  readonly entries: HarnessJournalEntry[] = [];
  append(entry: HarnessJournalEntry): void {
    this.entries.push(entry);
  }
}
