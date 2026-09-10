import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { PaneItem } from '../../state/paneItems';
import { usePanePresence } from './usePanePresence';

const PanePresentationContext = createContext<ReturnType<typeof usePanePresence> | null>(null);
const NO_EXITS: ReadonlySet<string> = new Set();
const finishImmediately = () => {};
const PaneVisualFocusContext = createContext<{ focusedPane: string | null; settleFocus: () => void } | null>(null);

/** Captions and transcripts share the same exiting set and removal commit. */
export function PanePresentationProvider({ ids, items, scope, enabled, focusedPane, children }: {
  ids: string[]; items: Record<string, PaneItem>; scope: string; enabled: boolean; focusedPane: string | null; children: React.ReactNode;
}) {
  const presence = usePanePresence(ids, items, scope, enabled);

  // Keep the processed inputs in the same state as their result. A render can
  // be retried or discarded; a ref would survive it and skip the pending update.
  const [focus, setFocus] = useState({ scope, enabled, target: focusedPane, visible: focusedPane, revision: 0 });
  if (focus.scope !== scope || focus.enabled !== enabled || focus.target !== focusedPane) {
    setFocus({
      scope, enabled, target: focusedPane, revision: focus.revision + 1,
      visible: focus.scope === scope && focus.enabled && enabled && focusedPane !== null
        ? focus.visible
        : focusedPane,
    });
  }

  // Keyboard/input ownership changes immediately; lighting waits for arrival.
  // The revision rejects a late finish from a superseded focus request.
  const settleFocus = useCallback(() => {
    // Layout effects may call this on every commit when there is no motion.
    // Do not enqueue another update once the visual focus has already arrived.
    if (focus.visible === focus.target) return;
    setFocus(current =>
      current.revision !== focus.revision || current.visible === current.target
        ? current
        : { ...current, visible: current.target },
    );
  }, [focus.revision, focus.visible, focus.target]);

  const visualFocus = useMemo(
    () => ({ focusedPane: focus.visible, settleFocus }),
    [focus.visible, settleFocus],
  );

  return <PanePresentationContext.Provider value={presence}>
    <PaneVisualFocusContext.Provider value={visualFocus}>{children}</PaneVisualFocusContext.Provider>
  </PanePresentationContext.Provider>;
}

export function usePresentedPaneFocus(fallback: string | null) {
  return useContext(PaneVisualFocusContext) ?? { focusedPane: fallback, settleFocus: finishImmediately };
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
