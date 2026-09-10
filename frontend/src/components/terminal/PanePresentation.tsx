import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
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

  // --- Visual focus state machine ---
  // `target` (= focusedPane) updates immediately for keyboard/input ownership.
  // `visible` is deferred until the pane motion animation finishes (via
  // `settleFocus`), so the departing pane stays lit while expanding/scrolling.
  //
  // Previously this used render-phase setState which triggered React error
  // #185 (maximum update depth exceeded) during rapid workspace switches
  // where scope, enabled, and focusedPane all changed in the same batch.
  //
  // Now: a ref tracks the latest prop values and a monotonic revision counter.
  // Only `visible` lives in state (for the deferred lighting update).
  // No setState during render → no infinite loop risk.

  const revisionRef = useRef(0);
  const prevRef = useRef({ scope, enabled, target: focusedPane });
  const [visibleState, setVisibleState] = useState({ visible: focusedPane, revision: 0 });

  // Detect prop changes that affect the visual focus.
  const prev = prevRef.current;
  const scopeChanged = prev.scope !== scope;
  const targetChanged = prev.target !== focusedPane;
  const enabledChanged = prev.enabled !== enabled;

  if (scopeChanged || enabledChanged || targetChanged) {
    // Compute the new visible pane. Same logic as before:
    // - Cross-scope or re-enable: snap visible to the new target (no deferred animation).
    // - Same scope, same enabled: keep previous visible (wait for settleFocus).
    const snapToTarget = scopeChanged || enabledChanged || focusedPane === null;
    const nextVisible = snapToTarget ? focusedPane : visibleState.visible;
    const nextRevision = ++revisionRef.current;

    prevRef.current = { scope, enabled, target: focusedPane };

    // Only update state when the derived visible value actually differs.
    // This prevents a re-render cascade when only `target` changed but
    // visible stays the same.
    if (nextVisible !== visibleState.visible || nextRevision !== visibleState.revision) {
      // Use the functional-update overload so React batches this with the
      // parent's render rather than scheduling a new one.  Because the new
      // value is purely derived from props+ref (not from `current` state),
      // it stabilises in one pass and cannot loop.
      setVisibleState({ visible: nextVisible, revision: nextRevision });
    }
  }

  const currentRevision = revisionRef.current;

  // Keyboard/input ownership changes immediately; lighting waits for arrival.
  // The revision rejects a late finish from a superseded focus request.
  const settleFocus = useCallback(() => {
    setVisibleState(current =>
      current.revision !== currentRevision || current.visible === focusedPane
        ? current
        : { ...current, visible: focusedPane },
    );
  }, [currentRevision, focusedPane]);

  const visualFocus = useMemo(
    () => ({ focusedPane: visibleState.visible, settleFocus }),
    [visibleState.visible, settleFocus],
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
