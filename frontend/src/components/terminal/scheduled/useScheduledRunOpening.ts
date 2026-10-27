import React from 'react';
import { toast } from 'sonner';
import { getElectron, type ScheduledRunTarget } from '../../../lib/electronBridge';
import { notify } from '../../../services/notifications';
import { useChatActions } from '../../../state/chatStore';
import type { PageId } from '../../../state/commands';
import { requestScheduledJobDetail } from './scheduledNav';
import { closeMetaAgentDetail } from './metaAgent/metaAgentNav';

const OPEN_RUN_PARAMS = ['michiOpenRun', 'michiOpenJob', 'michiOpenWorkspace', 'michiOpenNode'];

/** Drop the one-shot "open this run" params so a reload does not reopen it. */
function clearOpenRunParams(): void {
  try {
    const url = new URL(window.location.href);
    if (!OPEN_RUN_PARAMS.some((key) => url.searchParams.has(key))) return;
    for (const key of OPEN_RUN_PARAMS) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // Non-fatal: the worst case is reopening the same thread on reload.
  }
}

/**
 * Opens the thread behind a scheduled-run notification: from a click on an
 * OS notification (Electron IPC or the URL of a window it opened) and from
 * in-app toasts for notices delivered while Michi is focused.
 */
export function useScheduledRunOpening({ hydrated, onNav }: { hydrated: boolean; onNav: (page: PageId) => void }): void {
  const { revealBackendNode } = useChatActions();
  const pending = React.useRef<ScheduledRunTarget | null>(getElectron()?.initialScheduledRun ?? null);
  const hydratedRef = React.useRef(hydrated);
  hydratedRef.current = hydrated;

  const open = React.useCallback(async (target: ScheduledRunTarget) => {
    if (target.nodeId && await revealBackendNode(target.workspaceId, target.nodeId)) return;
    // No thread (failed before it started, or since deleted): show the job.
    if (target.nodeId) toast.error('That thread is no longer available');
    closeMetaAgentDetail();
    requestScheduledJobDetail(target.jobId);
    onNav('scheduled');
  }, [onNav, revealBackendNode]);

  React.useEffect(() => {
    if (!hydrated || !pending.current) return;
    const target = pending.current;
    pending.current = null;
    clearOpenRunParams();
    void open(target);
  }, [hydrated, open]);

  React.useEffect(() => {
    const electron = getElectron();
    const detachOpen = electron?.onScheduledRunOpen?.((target) => {
      if (hydratedRef.current) void open(target);
      else pending.current = target;
    });
    const detachNotice = electron?.onScheduledNotice?.((notice) => {
      notify({
        title: `${notice.title} · ${notice.subtitle}`,
        body: notice.body,
        onClick: () => {
          if (hydratedRef.current) void open(notice.target);
          else pending.current = notice.target;
        },
      });
    });
    return () => {
      detachOpen?.();
      detachNotice?.();
    };
  }, [open]);
}
