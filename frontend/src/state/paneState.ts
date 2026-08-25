import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, ViewMode } from './chatTypes';
import { isPaneItem, type PaneItem } from './paneItems';
export type { ViewMode } from './chatTypes';

type PaneUpdater<T> = T | ((prev: T) => T);

const PANE_OPEN_KEY = 'michi:panes:open';
const PANE_FOCUS_KEY = 'michi:panes:focus';
const PANE_ITEMS_KEY = 'michi:panes:items:v1';

function readPaneMap<T>(key: string, fallback: T): T {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch { /* corrupt or missing */ }
  return fallback;
}

function writePaneMap(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* quota or private browsing */ }
}

function readPaneItems(): Record<string, PaneItem> {
  const parsed = readPaneMap<Record<string, unknown>>(PANE_ITEMS_KEY, {});
  const items: Record<string, PaneItem> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (isPaneItem(value) && value.id === id) items[id] = value;
  }
  return items;
}

/**
 * Remove a set of dead node ids from the pane maps across EVERY pane key
 * (every `projectId::treeId` slot), not just the active one. This is the core
 * of the "a node deleted in one view/tab still has an open pane in another"
 * fix: `deleteNode`/`trimNode` only clear the pane key they run in, so a node
 * that becomes `deletedAt` via sync (or a delete dispatched while a different
 * tree/tab is active) can linger in some other slot's `openPanes`.
 *
 * Identity-preserving: returns the SAME map references when nothing was dead,
 * and preserves each untouched pane-key array by reference, so a wiring effect
 * can bail out cheaply without forcing spurious re-renders. A focused pane that
 * pointed at a dead id falls back to the last remaining pane in that key (or
 * null when none remain).
 */
export function prunePaneMaps(
  openPanesMap: Record<string, string[]>,
  focusedPaneMap: Record<string, string | null>,
  deadIds: ReadonlySet<string>,
): { openPanesMap: Record<string, string[]>; focusedPaneMap: Record<string, string | null> } {
  if (deadIds.size === 0) return { openPanesMap, focusedPaneMap };

  let openChanged = false;
  const nextOpen: Record<string, string[]> = {};
  for (const [key, panes] of Object.entries(openPanesMap)) {
    if (!panes.some((id) => deadIds.has(id))) {
      nextOpen[key] = panes; // untouched key keeps its array reference
      continue;
    }
    openChanged = true;
    nextOpen[key] = panes.filter((id) => !deadIds.has(id));
  }
  if (!openChanged) return { openPanesMap, focusedPaneMap };

  let focusChanged = false;
  const nextFocused: Record<string, string | null> = {};
  for (const [key, focused] of Object.entries(focusedPaneMap)) {
    if (focused !== null && deadIds.has(focused)) {
      focusChanged = true;
      const remaining = nextOpen[key] ?? [];
      nextFocused[key] = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    } else {
      nextFocused[key] = focused;
    }
  }

  return {
    openPanesMap: nextOpen,
    focusedPaneMap: focusChanged ? nextFocused : focusedPaneMap,
  };
}

interface UsePaneStateArgs {
  projects: Project[];
  activeProjectId: string | null;
}

export function usePaneState({ projects, activeProjectId }: UsePaneStateArgs) {
  const [openPanesMap, setOpenPanesMap] = useState<Record<string, string[]>>(
    () => readPaneMap<Record<string, string[]>>(PANE_OPEN_KEY, {}),
  );
  const [focusedPaneMap, setFocusedPaneMap] = useState<Record<string, string | null>>(
    () => readPaneMap<Record<string, string | null>>(PANE_FOCUS_KEY, {}),
  );
  const [paneItems, setPaneItems] = useState<Record<string, PaneItem>>(readPaneItems);
  const [viewMode, setViewModeState] = useState<ViewMode>('two');

  const activeProjectForPane = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const paneKey = activeProjectForPane?.activeTreeId
    ? `${activeProjectForPane.id}::${activeProjectForPane.activeTreeId}`
    : null;

  // Stable callbacks below read the latest active tree slot through this ref.
  const paneKeyRef = useRef(paneKey);
  paneKeyRef.current = paneKey;

  const openPanes = paneKey ? openPanesMap[paneKey] ?? [] : [];
  const focusedPane = paneKey ? focusedPaneMap[paneKey] ?? null : null;

  const setOpenPanes = useCallback((updater: PaneUpdater<string[]>) => {
    const key = paneKeyRef.current;
    if (!key) return;
    setOpenPanesMap((prev) => {
      const cur = prev[key] ?? [];
      const next = typeof updater === 'function' ? (updater as (p: string[]) => string[])(cur) : updater;
      return { ...prev, [key]: next };
    });
  }, []);

  const setFocusedPane = useCallback((updater: PaneUpdater<string | null>) => {
    const key = paneKeyRef.current;
    if (!key) return;
    setFocusedPaneMap((prev) => {
      const cur = prev[key] ?? null;
      const next =
        typeof updater === 'function'
          ? (updater as (p: string | null) => string | null)(cur)
          : updater;
      return { ...prev, [key]: next };
    });
  }, []);

  const retainProjectPaneKeys = useCallback((projectId: string | null) => {
    setOpenPanesMap((prev) => {
      const next: typeof prev = {};
      for (const [key, value] of Object.entries(prev)) {
        if (projectId && key.startsWith(`${projectId}::`)) next[key] = value;
      }
      return next;
    });
    setFocusedPaneMap((prev) => {
      const next: typeof prev = {};
      for (const [key, value] of Object.entries(prev)) {
        if (projectId && key.startsWith(`${projectId}::`)) next[key] = value;
      }
      return next;
    });
  }, []);

  const setPaneSlot = useCallback(
    (projectId: string, treeId: string, panes: string[], focused: string | null) => {
      const key = `${projectId}::${treeId}`;
      setOpenPanesMap((prev) => ({ ...prev, [key]: panes }));
      setFocusedPaneMap((prev) => ({ ...prev, [key]: focused }));
    },
    [],
  );

  const ensurePaneSlot = useCallback((projectId: string, treeId: string, rootNodeId: string) => {
    const key = `${projectId}::${treeId}`;
    setOpenPanesMap((prev) => (prev[key]?.length ? prev : { ...prev, [key]: [rootNodeId] }));
    setFocusedPaneMap((prev) => (prev[key] ? prev : { ...prev, [key]: rootNodeId }));
  }, []);

  // Mirror both pane maps so prunePaneIds can compute the prune against the
  // latest values outside any setState updater (updaters must stay pure) while
  // keeping the callback stable for the wiring effect.
  const openPanesMapRef = useRef(openPanesMap);
  openPanesMapRef.current = openPanesMap;
  const focusedPaneMapRef = useRef(focusedPaneMap);
  focusedPaneMapRef.current = focusedPaneMap;
  const paneItemsRef = useRef(paneItems);
  paneItemsRef.current = paneItems;

  // Persist pane layout to sessionStorage so refresh restores it.
  useEffect(() => { writePaneMap(PANE_OPEN_KEY, openPanesMap); }, [openPanesMap]);
  useEffect(() => { writePaneMap(PANE_FOCUS_KEY, focusedPaneMap); }, [focusedPaneMap]);
  useEffect(() => { writePaneMap(PANE_ITEMS_KEY, paneItems); }, [paneItems]);
  useEffect(() => {
    const flush = () => {
      writePaneMap(PANE_OPEN_KEY, openPanesMapRef.current);
      writePaneMap(PANE_FOCUS_KEY, focusedPaneMapRef.current);
      writePaneMap(PANE_ITEMS_KEY, paneItemsRef.current);
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  /**
   * Remove `deadIds` from EVERY pane key. Used by the chatStore effect that
   * closes panes whose node became `deletedAt` — including panes in a tree/tab
   * that isn't currently active, which `deleteNode`/`trimNode` (scoped to the
   * active pane key) can't reach. No-op (no setState) when nothing was open for
   * those ids, so it's safe to call on every nodes change.
   */
  const prunePaneIds = useCallback((deadIds: ReadonlySet<string>) => {
    const { openPanesMap: nextOpen, focusedPaneMap: nextFocused } = prunePaneMaps(
      openPanesMapRef.current,
      focusedPaneMapRef.current,
      deadIds,
    );
    if (nextOpen !== openPanesMapRef.current) setOpenPanesMap(nextOpen);
    if (nextFocused !== focusedPaneMapRef.current) setFocusedPaneMap(nextFocused);
  }, []);

  const openPane = useCallback(
    (nodeId: string) => {
      setOpenPanes((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
      setFocusedPane(nodeId);
    },
    [setFocusedPane, setOpenPanes],
  );

  const registerPaneItem = useCallback((item: PaneItem) => {
    setPaneItems((prev) => prev[item.id] === item ? prev : { ...prev, [item.id]: item });
  }, []);

  const updatePaneItem = useCallback((id: string, patch: Partial<PaneItem>) => {
    setPaneItems((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const next = { ...current, ...patch, id: current.id, kind: current.kind } as PaneItem;
      return { ...prev, [id]: next };
    });
  }, []);

  const removePaneItem = useCallback((id: string) => {
    setPaneItems((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const setPaneItemWidth = useCallback((id: string, width: number | undefined) => {
    setPaneItems((prev) => {
      const current = prev[id];
      if (!current || current.width === width) return prev;
      const next = { ...current } as PaneItem;
      if (width === undefined) delete next.width;
      else next.width = width;
      return { ...prev, [id]: next };
    });
  }, []);

  const openPaneInTree = useCallback(
    (projectId: string, treeId: string, nodeId: string) => {
      const key = `${projectId}::${treeId}`;
      setOpenPanesMap((prev) => {
        const cur = prev[key] ?? [];
        return cur.includes(nodeId) ? prev : { ...prev, [key]: [...cur, nodeId] };
      });
      setFocusedPaneMap((prev) => ({ ...prev, [key]: nodeId }));
    },
    [],
  );

  /** Open a pane in an explicit tree slot without stealing that slot's focus.
   * Background stream events must not move the user between panes or trees. */
  const appendPaneInTree = useCallback(
    (projectId: string, treeId: string, nodeId: string) => {
      const key = `${projectId}::${treeId}`;
      setOpenPanesMap((prev) => {
        const cur = prev[key] ?? [];
        return cur.includes(nodeId) ? prev : { ...prev, [key]: [...cur, nodeId] };
      });
    },
    [],
  );

  const closePane = useCallback(
    (nodeId: string) => {
      setOpenPanes((prev) => {
        const next = prev.filter((id) => id !== nodeId);
        setFocusedPane((cur) => {
          if (cur !== nodeId) return cur;
          return next[next.length - 1] ?? null;
        });
        return next;
      });
    },
    [setFocusedPane, setOpenPanes],
  );

  const focusPane = useCallback(
    (nodeId: string) => {
      setOpenPanes((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
      setFocusedPane(nodeId);
    },
    [setFocusedPane, setOpenPanes],
  );

  // Reorder an open pane: move `fromId` so it sits at the index currently
  // occupied by `toId`. No-op when either id isn't currently open or the two
  // are the same. Used by tab-strip and pane-header drag-and-drop.
  const reorderPane = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      setOpenPanes((prev) => {
        const fromIdx = prev.indexOf(fromId);
        const toIdx = prev.indexOf(toId);
        if (fromIdx === -1 || toIdx === -1) return prev;
        const next = prev.slice();
        next.splice(fromIdx, 1);
        const insertAt = next.indexOf(toId);
        next.splice(insertAt + (fromIdx < toIdx ? 1 : 0), 0, fromId);
        return next;
      });
    },
    [setOpenPanes],
  );

  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode);
  }, []);

  return {
    openPanes,
    focusedPane,
    paneItems,
    viewMode,
    setOpenPanes,
    setFocusedPane,
    openPane,
    registerPaneItem,
    updatePaneItem,
    removePaneItem,
    setPaneItemWidth,
    openPaneInTree,
    appendPaneInTree,
    closePane,
    focusPane,
    reorderPane,
    setViewMode,
    retainProjectPaneKeys,
    setPaneSlot,
    ensurePaneSlot,
    prunePaneIds,
  };
}
