import React from 'react';
import {
  createMaintenanceWatch,
  deleteMaintenanceWatch,
  getPageMaintenance,
  queuePageMaintenanceCatchUp,
  reconsiderPageMaintenanceSources,
  runMaintenanceWatch,
  runPageMaintenanceNow,
  saveMaintenanceInstructions,
  setPageMaintenanceSpaceExcluded,
  updateMaintenanceWatch,
  updatePageMaintenance,
  type MaintenanceWatchInput,
  type PageMaintenanceConfigPatch,
  type PageMaintenanceIdentity,
  type PageMaintenanceWorkspace,
} from '../../services/api/pageMaintenance';
import { SCHEDULED_JOB_RUN_WINDOW_EVENT, SCHEDULED_JOBS_CHANGED_WINDOW_EVENT } from '../../components/terminal/scheduled/scheduledNav';

export interface PageMaintenanceState {
  value: PageMaintenanceWorkspace | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => void;
  update: (patch: PageMaintenanceConfigPatch) => Promise<void>;
  setSpaceExcluded: (spaceId: string, excluded: boolean) => Promise<void>;
  runNow: () => Promise<void>;
  reconsider: (planId: string, sourceTurnIds: string[]) => Promise<void>;
  catchUp: (spaceId: string, after: number, through: number) => Promise<{ requestId: string; after: number; through: number; queued: true }>;
  saveInstructions: (text: string) => Promise<void>;
  addWatch: (input: MaintenanceWatchInput) => Promise<void>;
  /** Saved against the watch's revision as last loaded. */
  changeWatch: (watchId: string, patch: Partial<MaintenanceWatchInput>) => Promise<void>;
  removeWatch: (watchId: string) => Promise<void>;
  runWatch: (watchId: string) => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Page maintenance could not be loaded.';
}

export function usePageMaintenance(identity: PageMaintenanceIdentity): PageMaintenanceState {
  const { backendConnectionId, workspaceId } = identity;
  const [value, setValue] = React.useState<PageMaintenanceWorkspace | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [revision, setRevision] = React.useState(0);
  const refresh = React.useCallback(() => setRevision((current) => current + 1), []);

  React.useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setError(null);
    getPageMaintenance({ backendConnectionId, workspaceId, signal: controller.signal })
      .then((next) => { if (current) setValue(next); })
      .catch((cause) => { if (current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(message(cause)); })
      .finally(() => { if (current) setLoading(false); });
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 15_000);
    const onScheduledChange = () => refresh();
    window.addEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onScheduledChange);
    window.addEventListener(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT, onScheduledChange);
    return () => {
      current = false;
      controller.abort();
      window.clearInterval(poll);
      window.removeEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onScheduledChange);
      window.removeEventListener(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT, onScheduledChange);
    };
  }, [backendConnectionId, refresh, revision, workspaceId]);

  const mutate = React.useCallback(async (action: (options: PageMaintenanceIdentity) => Promise<PageMaintenanceWorkspace | unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action({ backendConnectionId, workspaceId });
      if (next && typeof next === 'object' && 'config' in next && 'backlog' in next) setValue(next as PageMaintenanceWorkspace);
      else refresh();
    } catch (cause) {
      setError(message(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [backendConnectionId, refresh, workspaceId]);

  const update = React.useCallback((patch: PageMaintenanceConfigPatch) => mutate((options) => updatePageMaintenance(patch, options)), [mutate]);
  const setSpaceExcluded = React.useCallback((spaceId: string, excluded: boolean) => mutate((options) =>
    setPageMaintenanceSpaceExcluded(spaceId, excluded, value?.config?.revision ?? 0, options)), [mutate, value?.config?.revision]);
  const runNow = React.useCallback(() => mutate((options) => runPageMaintenanceNow(options)), [mutate]);
  const reconsider = React.useCallback((planId: string, sourceTurnIds: string[]) => mutate((options) =>
    reconsiderPageMaintenanceSources(planId, sourceTurnIds, value?.config?.revision ?? 0, options)), [mutate, value?.config?.revision]);
  const catchUp = React.useCallback(async (spaceId: string, after: number, through: number) => {
    setBusy(true);
    setError(null);
    try {
      const queued = await queuePageMaintenanceCatchUp(spaceId, after, through, { backendConnectionId, workspaceId });
      refresh();
      return queued;
    } catch (cause) {
      setError(message(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [backendConnectionId, refresh, workspaceId]);

  const instructionsRevision = value?.instructions?.revision ?? 0;
  const saveInstructions = React.useCallback((text: string) => mutate((options) =>
    saveMaintenanceInstructions(text, instructionsRevision, options)), [instructionsRevision, mutate]);
  const addWatch = React.useCallback((input: MaintenanceWatchInput) => mutate((options) => createMaintenanceWatch(input, options)), [mutate]);
  const watches = value?.watches;
  const changeWatch = React.useCallback((watchId: string, patch: Partial<MaintenanceWatchInput>) => mutate((options) =>
    updateMaintenanceWatch(watchId, { ...patch, expectedRevision: watches?.find((watch) => watch.id === watchId)?.revision ?? 0 }, options)), [mutate, watches]);
  const removeWatch = React.useCallback((watchId: string) => mutate((options) => deleteMaintenanceWatch(watchId, options)), [mutate]);
  const runWatch = React.useCallback((watchId: string) => mutate((options) => runMaintenanceWatch(watchId, options)), [mutate]);

  return { value, loading, busy, error, refresh, update, setSpaceExcluded, runNow, reconsider, catchUp,
    saveInstructions, addWatch, changeWatch, removeWatch, runWatch };
}
