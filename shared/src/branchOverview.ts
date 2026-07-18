/**
 * Branch overview journal — append-only per-turn entries.
 *
 * The wire format is unchanged: each turn still produces a single overview
 * string (sentinel or set_branch_overview tool). Append semantics live at the
 * two projection sinks — the frontend node reducer and the backend node-row
 * writer — which both funnel through these helpers. The sqlite
 * `nodes.branch_overview` TEXT column stores a JSON entry array; legacy rows
 * hold the old single-snapshot plain string and hydrate as a one-entry journal.
 */

export interface BranchOverviewEntry {
  /** Epoch ms when the entry was recorded. 0 for legacy single-string rows. */
  at: number;
  text: string;
}

function isEntry(value: unknown): value is BranchOverviewEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.at === 'number'
    && Number.isFinite(entry.at)
    && typeof entry.text === 'string'
    && entry.text.trim().length > 0;
}

function fromArray(value: unknown[]): BranchOverviewEntry[] {
  return value.filter(isEntry).map((entry) => ({ at: entry.at, text: entry.text.trim() }));
}

/**
 * Parse a persisted branch-overview value into journal entries. Accepts the
 * JSON entry-array column format, an already-parsed entry array, or a legacy
 * plain-string snapshot (returned as a single entry with `at: 0`).
 */
export function parseBranchOverviewEntries(raw: unknown): BranchOverviewEntry[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return fromArray(raw);
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return fromArray(parsed);
    } catch {
      // Legacy snapshot text that happens to start with '[' — fall through.
    }
  }
  return [{ at: 0, text: trimmed }];
}

/**
 * Append one per-turn entry. Returns the SAME array reference when nothing
 * changes (empty text, or verbatim repeat of the last entry), so callers can
 * cheaply detect no-ops. The repeat guard absorbs the dual delivery channels
 * (structured event at checkpoint time + turn-end text fallback).
 */
export function appendBranchOverviewEntry(
  entries: BranchOverviewEntry[],
  text: string,
  at: number,
): BranchOverviewEntry[] {
  const next = text.trim();
  if (!next) return entries;
  if (entries.length > 0 && entries[entries.length - 1].text === next) return entries;
  return [...entries, { at, text: next }];
}

/** Serialize for the `nodes.branch_overview` TEXT column. Empty → null. */
export function serializeBranchOverviewEntries(entries: BranchOverviewEntry[]): string | null {
  return entries.length > 0 ? JSON.stringify(entries) : null;
}
