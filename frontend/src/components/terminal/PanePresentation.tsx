import React, { createContext, useContext } from 'react';
import type { PaneItem } from '../../state/paneItems';
import { usePanePresence } from './usePanePresence';

const PanePresentationContext = createContext<ReturnType<typeof usePanePresence> | null>(null);
const NO_EXITS: ReadonlySet<string> = new Set();
const finishImmediately = () => {};

/** Captions and transcripts share the same exiting set and removal commit. */
export function PanePresentationProvider({ ids, items, scope, enabled, children }: {
  ids: string[]; items: Record<string, PaneItem>; scope: string; enabled: boolean; children: React.ReactNode;
}) {
  const presence = usePanePresence(ids, items, scope, enabled);
  return <PanePresentationContext.Provider value={presence}>{children}</PanePresentationContext.Provider>;
}

export function usePresentedPanes(ids: string[], items: Record<string, PaneItem>) {
  return useContext(PanePresentationContext) ?? { paneIds: ids, paneItems: items, exitingIds: NO_EXITS, holdExits: finishImmediately, finishExit: finishImmediately };
}

export function usePaneIsExiting(id: string) {
  return useContext(PanePresentationContext)?.exitingIds.has(id) ?? false;
}

export const RetainedPaneContent = React.memo(function RetainedPaneContent({ children }: {
  exiting: boolean; children: React.ReactNode;
}) {
  return <>{children}</>;
}, (_previous, next) => next.exiting);
