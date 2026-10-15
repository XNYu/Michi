/**
 * Durable agent picks for composers that create a conversation on submit
 * (Home and digest follow-ups). The pick has no thread to live on yet, so it
 * is small scoped UI state in localStorage; once a thread exists its own
 * binding (nodes.current_mode_id / agent_definition_id) is authoritative.
 *
 * - Mode picks are keyed by Backend + runtime: mode ids belong to one
 *   runtime's catalog, and a pick made under Kiro must not leak into Claude.
 *   A pick missing from the current catalog is ignored at render time, not
 *   pruned, because workspace-level agents differ between workspaces.
 * - Primary-agent picks are keyed by workspace and store ids only; the
 *   composer resolves them against the freshly listed definitions.
 *
 * Entries are stored as ordered [key, value] pairs so the cap evicts the
 * least recently written key.
 */

export const COMPOSER_AGENT_SELECTION_STORAGE_KEY = 'michi:v1:composer-agent-selection';

/** Upper bound per list; old workspaces and Backends would otherwise accumulate forever. */
const MAX_ENTRIES = 50;

export interface ComposerPrimaryAgentSelection {
  backendConnectionId: string;
  definitionId: string;
}

type Pairs<T> = ReadonlyArray<readonly [string, T]>;

interface StoredSelections {
  version: 1;
  modes: Pairs<string>;
  primaryAgents: Pairs<ComposerPrimaryAgentSelection>;
}

const EMPTY: StoredSelections = { version: 1, modes: [], primaryAgents: [] };

// Parsed view of the last raw string seen. The composer reads on every render,
// so re-parse only when the stored text changes (including other windows' writes).
let parsedCache: { raw: string | null; value: StoredSelections } | null = null;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Undefined while the runtime is unknown, so nothing is read or written under a guess. */
function modeKey(backendConnectionId: string, runtimeId: string | undefined): string | undefined {
  return runtimeId ? JSON.stringify([backendConnectionId, runtimeId]) : undefined;
}

function parsePairs<T>(value: unknown, parseValue: (raw: unknown) => T | undefined): Array<readonly [string, T]> {
  if (!Array.isArray(value)) return [];
  const pairs: Array<readonly [string, T]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isNonEmptyString(entry[0])) continue;
    const parsed = parseValue(entry[1]);
    if (parsed !== undefined) pairs.push([entry[0], parsed]);
  }
  return pairs;
}

function parsePrimaryAgent(raw: unknown): ComposerPrimaryAgentSelection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { backendConnectionId, definitionId } = raw as Record<string, unknown>;
  return isNonEmptyString(backendConnectionId) && isNonEmptyString(definitionId)
    ? { backendConnectionId, definitionId }
    : undefined;
}

function parseStored(raw: string | null): StoredSelections {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    return {
      version: 1,
      modes: parsePairs(parsed.modes, (value) => (isNonEmptyString(value) ? value : undefined)),
      primaryAgents: parsePairs(parsed.primaryAgents, parsePrimaryAgent),
    };
  } catch {
    return EMPTY;
  }
}

function load(): StoredSelections {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(COMPOSER_AGENT_SELECTION_STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  if (parsedCache?.raw === raw) return parsedCache.value;
  const value = parseStored(raw);
  parsedCache = { raw, value };
  return value;
}

function save(next: StoredSelections): void {
  const raw = JSON.stringify(next);
  try {
    window.localStorage.setItem(COMPOSER_AGENT_SELECTION_STORAGE_KEY, raw);
    parsedCache = { raw, value: next };
  } catch {
    // Quota or disabled storage: the pick will not survive a reload. Callers
    // keep their own in-session copy, so the current session is unaffected.
  }
}

function lookup<T>(pairs: Pairs<T>, key: string): T | undefined {
  return pairs.find(([candidate]) => candidate === key)?.[1];
}

/** Move `key` to the newest position (or drop it when `value` is undefined), keeping the cap. */
function withEntry<T>(pairs: Pairs<T>, key: string, value: T | undefined): Pairs<T> {
  const rest = pairs.filter(([candidate]) => candidate !== key);
  const next = value === undefined ? rest : [...rest, [key, value] as const];
  return next.slice(-MAX_ENTRIES);
}

export function readComposerModeSelection(
  backendConnectionId: string,
  runtimeId: string | undefined,
): string | undefined {
  const key = modeKey(backendConnectionId, runtimeId);
  return key ? lookup(load().modes, key) : undefined;
}

/** Record (or with `undefined`, forget) the mode picked for this Backend + runtime. */
export function writeComposerModeSelection(
  backendConnectionId: string,
  runtimeId: string | undefined,
  modeId: string | undefined,
): void {
  const key = modeKey(backendConnectionId, runtimeId);
  if (!key) return;
  const current = load();
  const value = modeId || undefined;
  if (lookup(current.modes, key) === value) return;
  save({ ...current, modes: withEntry(current.modes, key, value) });
}

export function readComposerPrimaryAgentSelection(workspaceId: string): ComposerPrimaryAgentSelection | undefined {
  return workspaceId ? lookup(load().primaryAgents, workspaceId) : undefined;
}

/** Record (or with `undefined`, forget) the primary agent picked for this workspace. */
export function writeComposerPrimaryAgentSelection(
  workspaceId: string,
  selection: ComposerPrimaryAgentSelection | undefined,
): void {
  if (!workspaceId) return;
  const current = load();
  const existing = lookup(current.primaryAgents, workspaceId);
  if (existing?.backendConnectionId === selection?.backendConnectionId
    && existing?.definitionId === selection?.definitionId) return;
  const value = selection
    ? { backendConnectionId: selection.backendConnectionId, definitionId: selection.definitionId }
    : undefined;
  save({ ...current, primaryAgents: withEntry(current.primaryAgents, workspaceId, value) });
}

export function clearComposerAgentSelections(): void {
  parsedCache = null;
  try {
    window.localStorage.removeItem(COMPOSER_AGENT_SELECTION_STORAGE_KEY);
  } catch {
    // Nothing persisted to clear.
  }
}
