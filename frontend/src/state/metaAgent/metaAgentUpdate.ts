import { useSyncExternalStore } from 'react';
import type { MetaAgentRunNowWorkspace } from 'michi-shared';
import { fetchMetaAgentRound, runMetaAgentRoundNow } from '../../services/api/pageMaintenance';
import { notifyPageChanged } from '../pages/pageEvents';
import { metaAgentGuardFailures, readMetaAgent, retryMetaAgentGuard } from './useMetaAgent';
import { firstRunActive, readSpacesFirstRun, startSpacesFirstRunVisit } from './spacesFirstRun';
import { refreshMetaAgentOverview, resumeMetaAgent } from './useMetaAgentOverview';

/**
 * The Spaces Home's Update button: one Meta agent round now instead of on
 * the next 60-second tick. The connection's backend starts every workspace
 * with unread conversations at once; with none, it says so and calls no model.
 */
export type MetaAgentUpdatePhase = 'idle' | 'running' | 'no-new' | 'failed';

export interface MetaAgentUpdateState {
  phase: MetaAgentUpdatePhase;
  /** Workspaces being read in this round. */
  workspaces: number;
  error: string | null;
}

const IDLE: MetaAgentUpdateState = { phase: 'idle', workspaces: 0, error: null };
export const UPDATE_POLL_MS = 3_000;
export const UPDATE_TIMEOUT_MS = 120_000;
export const UPDATE_NOTE_MS = 8_000;

let state = IDLE;
let round = 0;
let noteTimer: number | null = null;
const listeners = new Set<() => void>();

function set(next: MetaAgentUpdateState): void {
  state = next;
  for (const listener of listeners) listener();
}

function showBriefly(next: MetaAgentUpdateState, mine: number): void {
  set(next);
  if (noteTimer !== null) window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => { if (mine === round) set(IDLE); }, UPDATE_NOTE_MS);
}

const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

/** A round that started nothing: nothing new, or why a workspace was skipped. Null when every one is paused, which the status line already says. */
function quietResult(rows: readonly MetaAgentRunNowWorkspace[]): MetaAgentUpdateState | null {
  if (rows.length > 0 && rows.every((row) => row.skip === 'paused')) return null;
  const blocked = rows.find((row) => row.outcome === 'skipped' && row.skip !== 'paused');
  if (blocked) return { phase: 'failed', workspaces: 0, error: blocked.reason ?? 'The Meta agent could not start' };
  return { phase: 'no-new', workspaces: 0, error: null };
}

export async function runMetaAgentUpdate(connectionId: string): Promise<void> {
  const mine = ++round;
  if (noteTimer !== null) { window.clearTimeout(noteTimer); noteTimer = null; }
  const refreshPages = () => notifyPageChanged({ backendConnectionId: connectionId });
  const refreshLocalOverview = () => { if (connectionId === 'local') void refreshMetaAgentOverview(); };
  try {
    if (firstRunActive(readSpacesFirstRun(connectionId).data)) {
      await startSpacesFirstRunVisit(connectionId);
      set(IDLE);
      return;
    }
    // These checks belong to this computer's Meta agent; a remote backend reports its own hold in the round's answer.
    if (connectionId === 'local' && metaAgentGuardFailures(readMetaAgent().info).some((failure) => failure.toolset === 'maintenance')) {
      set({ phase: 'running', workspaces: 0, error: null });
      await retryMetaAgentGuard();
      if (mine === round) set(IDLE);
      refreshPages();
      return;
    }
    set({ phase: 'running', workspaces: 0, error: null });
    const result = await runMetaAgentRoundNow(connectionId);
    if (mine !== round) return;
    const reading = new Set(result.workspaces.filter((row) => row.outcome === 'started').map((row) => row.workspaceId));
    if (reading.size === 0) {
      refreshPages();
      refreshLocalOverview();
      const quiet = quietResult(result.workspaces);
      if (quiet) showBriefly(quiet, mine);
      else set(IDLE);
      return;
    }
    set({ phase: 'running', workspaces: reading.size, error: null });
    refreshLocalOverview();
    const deadline = Date.now() + UPDATE_TIMEOUT_MS;
    while (mine === round && Date.now() < deadline) {
      await wait(UPDATE_POLL_MS);
      if (mine !== round) return;
      const status = await fetchMetaAgentRound(connectionId).catch(() => null);
      if (status && !status.workspaces.some((row) => reading.has(row.workspaceId) && row.running)) break;
    }
    if (mine !== round) return;
    refreshPages();
    refreshLocalOverview();
    set(IDLE);
  } catch (error) {
    if (mine === round) showBriefly({ phase: 'failed', workspaces: 0, error: error instanceof Error ? error.message : 'Could not update' }, mine);
  }
}

export function readMetaAgentUpdate(): MetaAgentUpdateState {
  return state;
}

/**
 * Retry once the Meta agent stopped after repeated failures: resuming
 * restarts the stopped workspaces (this computer's backend only), then one
 * round runs now through Update's own path.
 */
export async function retryStoppedMetaAgent(connectionId: string): Promise<void> {
  if (connectionId === 'local') await resumeMetaAgent();
  await runMetaAgentUpdate(connectionId);
}

export function useMetaAgentUpdate(): MetaAgentUpdateState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readMetaAgentUpdate,
    readMetaAgentUpdate,
  );
}

export function resetMetaAgentUpdate(): void {
  round += 1;
  if (noteTimer !== null) window.clearTimeout(noteTimer);
  noteTimer = null;
  set(IDLE);
}
