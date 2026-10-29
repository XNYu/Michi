import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useMetaAgentSettingsAlert } from '../../../state/metaAgent/useMetaAgentOverview';
import { firstRunActive, firstRunProgress, subscribeFirstRunFinished, useSpacesFirstRun } from '../../../state/metaAgent/spacesFirstRun';
import { useSpaceConversationBadges } from '../spaces/home/homeLinks';
import { NO_RAIL_BADGES, type RailBadges } from './AreaRail';

/** The toast once every first read ends: how many workspace homes were written, and that reading turns incremental. */
export function firstRunFinishedNotice(written: number, failed: number, summaryWritten: boolean): string {
  const homes = `${written} workspace ${written === 1 ? 'home' : 'homes'}${summaryWritten ? ' + the Pages Home' : ''}`;
  return `Meta agent finished: ${homes}${failed ? ` (${failed} not written)` : ''}; from now on it reads only new conversations`;
}

// The rail and the Spaces sidebar both read the badges; only one of them shows the toast.
let toastOwner: object | null = null;

/**
 * Pages reminder badges are temporarily hidden. Scheduled shows a yellow
 * dot while the Meta agent's first run reads the history or a conversation
 * started from a Space runs, Conversations a green dot once such a
 * conversation finished unseen; Settings shows a red dot while a Meta agent
 * restriction check failed.
 */
export function useRailBadges(): RailBadges {
  const settingsAlert = useMetaAgentSettingsAlert();
  const conversations = useSpaceConversationBadges();
  const firstRun = useSpacesFirstRun('local');
  const scheduledRunning = conversations.scheduledRunning || firstRunActive(firstRun.data);
  useEffect(() => {
    if (toastOwner) return undefined;
    const owner = {};
    toastOwner = owner;
    const stop = subscribeFirstRunFinished((_connectionId, status) => {
      const progress = firstRunProgress(status);
      toast.success(firstRunFinishedNotice(progress.done, progress.failed.length, status.summary.state === 'done'));
    });
    return () => {
      stop();
      if (toastOwner === owner) toastOwner = null;
    };
  }, []);
  return useMemo(
    () => ({ ...NO_RAIL_BADGES, ...conversations, spacesWaiting: 0, scheduledRunning, settingsAlert }),
    [conversations, scheduledRunning, settingsAlert],
  );
}
