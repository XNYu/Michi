import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PaneItem } from '../../state/paneItems';
import { PANE_EXIT_MS } from './paneMotion';

/** Keep only the visual slot alive during exit; store close semantics stay immediate. */
export function usePanePresence(ids: readonly string[], items: Record<string, PaneItem>, scope: string, enabled = true, exitMs = PANE_EXIT_MS) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [state, setState] = useState(() => ({ scope, requested: ids, ids: [...ids], exiting: new Map<string, number>() }));

  // Track the inputs we last processed to avoid re-triggering during the
  // same render pass.  React 18 allows render-phase setState but it must
  // converge in one pass — if ANY subsequent parent render changes props
  // before the batch commits, the condition can fire again and loop.
  // Using a ref-gated guard ensures we process each distinct input exactly
  // once and never re-enter on the same values.
  const processedRef = useRef<{ scope: string; ids: readonly string[]; enabled: boolean }>({ scope, ids, enabled });

  const inputChanged = processedRef.current.scope !== scope
    || processedRef.current.ids !== ids
    || processedRef.current.enabled !== enabled;
  const needsClear = (!enabled || reduced) && state.exiting.size > 0;
  const idsContentChanged = state.scope !== scope
    || state.requested.length !== ids.length
    || state.requested.some((id, i) => id !== ids[i]);

  if (inputChanged && (idsContentChanged || needsClear)) {
    processedRef.current = { scope, ids, enabled };

    const exiting = new Map(state.exiting);
    const rendered = [...ids];
    const retain = enabled && !reduced && state.scope === scope;
    if (retain) {
      for (const [index, id] of state.ids.entries()) {
        if (ids.includes(id)) {
          exiting.delete(id);
        } else {
          if (!exiting.has(id)) exiting.set(id, performance.now() + exitMs + 32);
          const nextId = state.ids.slice(index + 1).find(candidate => rendered.includes(candidate));
          rendered.splice(nextId ? rendered.indexOf(nextId) : rendered.length, 0, id);
        }
      }
    } else exiting.clear();
    setState({ scope, requested: ids, ids: rendered, exiting });
  } else if (inputChanged) {
    // Props changed but no meaningful state update needed — still record
    // that we saw this input so we don't re-check on the next render.
    processedRef.current = { scope, ids, enabled };
  }
  // Cache PaneItem props as well: closing native/utility panes removes their store entry.
  const cachedItems = useRef(items);
  const retainedItems = useMemo(() => Object.fromEntries(state.ids.flatMap(id => {
    const item = items[id] ?? (state.scope === scope && !ids.includes(id) ? cachedItems.current[id] : undefined);
    return item ? [[id, item]] : [];
  })), [state, items, ids, scope]);
  cachedItems.current = retainedItems;

  useEffect(() => {
    const deadlines = [...state.exiting.values()].filter(Number.isFinite);
    if (deadlines.length === 0) return;
    const timer = window.setTimeout(() => {
      setState(current => {
        const exiting = new Map([...current.exiting].filter(([, until]) => until > performance.now()));
        return { ...current, exiting, ids: current.ids.filter(id => !current.exiting.has(id) || exiting.has(id)) };
      });
    }, Math.max(0, Math.min(...deadlines) - performance.now()));
    return () => window.clearTimeout(timer);
  }, [state]);

  // Once a renderer owns the exit, its animation clock also owns removal.
  // A wall-clock timeout must not remove a paused or delayed visual early.
  const holdExits = useCallback((ids: readonly string[]) => {
    setState(current => {
      const pending = ids.filter(id => current.exiting.has(id) && current.exiting.get(id) !== Infinity);
      if (pending.length === 0) return current;
      const exiting = new Map(current.exiting);
      for (const id of pending) exiting.set(id, Infinity);
      return { ...current, exiting };
    });
  }, []);

  const finishExit = useCallback((id: string) => {
    setState(current => {
      if (!current.exiting.has(id) || current.requested.includes(id)) return current;
      const exiting = new Map(current.exiting);
      exiting.delete(id);
      return { ...current, exiting, ids: current.ids.filter(candidate => candidate !== id) };
    });
  }, []);

  return { paneIds: state.ids, paneItems: retainedItems, exitingIds: useMemo(() => new Set(state.exiting.keys()), [state.exiting]), holdExits, finishExit };
}
