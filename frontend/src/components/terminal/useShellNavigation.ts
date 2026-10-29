import { useCallback, useLayoutEffect, useMemo } from 'react';
import type { PageId } from '../../state/commands';
import { useNavHistory, type NavEntry } from '../../state/navHistory';
import { navigateToNode, type NavigateToNodeDeps } from '../../state/navigateToNode';
import type { SpacesHomeTarget } from '../../state/shellArea';
import type { ScheduledRoute } from './scheduled/scheduledNav';
import type { NativePageRoute } from './spaces/SpacesPage';

export interface ShellLocation {
  page: PageId;
  spaceRoute: NativePageRoute;
  spacesHome: SpacesHomeTarget;
  scheduledRoute: ScheduledRoute;
  chat: NavEntry | null;
}

function locationKey(location: ShellLocation | null): string {
  if (!location) return '';
  const { page, spaceRoute, spacesHome, scheduledRoute, chat } = location;
  if (page === 'space' && spaceRoute.type === 'space') {
    return JSON.stringify([page, spaceRoute.backendConnectionId, spaceRoute.workspaceId, spaceRoute.pageId]);
  }
  if (page === 'scheduled') return JSON.stringify([page, scheduledRoute.kind, scheduledRoute.kind === 'job' ? scheduledRoute.jobId : null]);
  if (page === 'spaces') return JSON.stringify([page, spacesHome]);
  if (page === 'dashboard') return JSON.stringify([page, chat]);
  return page;
}

const landedAtLocation = (a: ShellLocation, b: ShellLocation) =>
  a.page === 'dashboard' && b.page === 'dashboard' && a.chat && b.chat
    ? a.chat.nodeId === b.chat.nodeId && a.chat.projectId === b.chat.projectId
    : sameLocation(a, b);

const sameLocation = (a: ShellLocation | null, b: ShellLocation | null) => locationKey(a) === locationKey(b);

/** Record visible destinations, never the hidden chat focus behind a Page. */
export function useShellNavigation({ location, hydrated, deps, restore, isChatLive, isScheduledJobLive }: {
  location: ShellLocation;
  hydrated: boolean;
  deps: NavigateToNodeDeps;
  restore: (location: ShellLocation) => void;
  isChatLive: (entry: NavEntry) => boolean;
  isScheduledJobLive?: (jobId: string) => boolean;
}) {
  const { record, back, forward, prune, canBack, canForward } = useNavHistory<ShellLocation>(sameLocation, landedAtLocation);
  const isLive = useCallback((entry: ShellLocation) => {
    if (entry.page === 'scheduled' && entry.scheduledRoute.kind === 'job') {
      return isScheduledJobLive?.(entry.scheduledRoute.jobId) ?? true;
    }
    return !entry.chat || isChatLive(entry.chat);
  }, [isChatLive, isScheduledJobLive]);
  useLayoutEffect(() => {
    if (!hydrated) return;
    record(location);
    prune(isLive);
  }, [hydrated, location, record, prune, isLive]);

  const go = useCallback((direction: 'back' | 'forward') => {
    const target = (direction === 'back' ? back : forward)(isLive);
    if (!target) return;
    if (target.chat) navigateToNode(deps, target.chat.nodeId, target.chat.projectId);
    restore(target);
  }, [back, forward, isLive, deps, restore]);
  const onBack = useCallback(() => go('back'), [go]);
  const onForward = useCallback(() => go('forward'), [go]);
  return useMemo(() => ({ canBack, canForward, onBack, onForward }), [canBack, canForward, onBack, onForward]);
}
