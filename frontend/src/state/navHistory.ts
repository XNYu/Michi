import { useCallback, useRef, useState } from 'react';

/**
 * Browser-style back/forward navigation history for the focused chat location.
 *
 * An entry captures the full home of a focused node — `nodeId` plus its
 * `projectId`/`treeId` — because back/forward must be able to cross workspace
 * and tree boundaries, and `retainProjectPaneKeys` drops other workspaces' pane
 * slots from memory on switch. The extra coordinates let `navigateToNode`
 * re-seed the destination slot (see navigateToNode.ts) rather than writing a
 * stale id into the wrong pane key.
 *
 * The model is a single global (per-window) stack — from workspace B you can
 * step all the way back into workspace A, matching a web browser / VS Code, not
 * Slack's per-workspace stacks. Nothing is persisted: reload starts empty.
 */
export interface NavEntry {
  nodeId: string;
  projectId: string;
  treeId: string;
}

export type IsLive = (entry: NavEntry) => boolean;

/** Max back entries kept; oldest is dropped FIFO past this. */
const CAP = 50;

function sameEntry(a: NavEntry | null, b: NavEntry | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.nodeId === b.nodeId && a.projectId === b.projectId && a.treeId === b.treeId;
}

/**
 * Pure two-stack navigation model, no React. Kept framework-free so the stack
 * semantics (dedup, cap, forward-clear, dead-entry skipping, and the
 * transition-suppression window) are unit-testable in isolation.
 */
export class NavHistoryStore {
  private backStack: NavEntry[] = [];
  private forwardStack: NavEntry[] = [];
  private current: NavEntry | null = null;
  /**
   * While set, `record` is suppressed until it observes a focus change landing
   * on this node. A back/forward navigation calls `navigateToNode`, which drives
   * the exact focus change the observer would otherwise record as a *new*
   * location (re-pushing the entry we just left). Matching on `nodeId` (not the
   * whole triple) tolerates intermediate renders during a cross-workspace
   * transition and any tree-id the destination resolves to.
   */
  private suppress: NavEntry | null = null;

  /** Record the current focused location. Returns true if the stacks changed. */
  record(entry: NavEntry): boolean {
    if (this.suppress) {
      if (entry.nodeId === this.suppress.nodeId) {
        this.suppress = null;
        this.current = entry; // align current to the actual landing triple
      }
      return false;
    }
    if (sameEntry(entry, this.current)) return false;
    if (this.current) {
      this.backStack.push(this.current);
      if (this.backStack.length > CAP) this.backStack.shift();
    }
    this.current = entry;
    this.forwardStack = [];
    return true;
  }

  /** Step back to the newest live entry, skipping (dropping) dead ones. */
  back(isLive: IsLive): NavEntry | null {
    while (this.backStack.length > 0) {
      const cand = this.backStack.pop()!;
      if (!isLive(cand)) continue; // node deleted / workspace gone — skip like a closed tab
      if (this.current && isLive(this.current)) this.forwardStack.push(this.current);
      this.current = cand;
      this.suppress = cand;
      return cand;
    }
    return null;
  }

  /** Step forward to the newest live entry, skipping (dropping) dead ones. */
  forward(isLive: IsLive): NavEntry | null {
    while (this.forwardStack.length > 0) {
      const cand = this.forwardStack.pop()!;
      if (!isLive(cand)) continue;
      if (this.current && isLive(this.current)) this.backStack.push(this.current);
      this.current = cand;
      this.suppress = cand;
      return cand;
    }
    return null;
  }

  /** Drop dead entries from both stacks. Returns true if anything was removed. */
  prune(isLive: IsLive): boolean {
    const nextBack = this.backStack.filter(isLive);
    const nextForward = this.forwardStack.filter(isLive);
    const changed =
      nextBack.length !== this.backStack.length || nextForward.length !== this.forwardStack.length;
    this.backStack = nextBack;
    this.forwardStack = nextForward;
    return changed;
  }

  canBack(): boolean {
    return this.backStack.length > 0;
  }

  canForward(): boolean {
    return this.forwardStack.length > 0;
  }
}

export interface NavHistory {
  /** Observe a focus change; no-op when it's the current spot or a nav landing. */
  record: (entry: NavEntry) => void;
  /** Navigate back one live entry; returns the target (or null if none). */
  back: (isLive: IsLive) => NavEntry | null;
  /** Navigate forward one live entry; returns the target (or null if none). */
  forward: (isLive: IsLive) => NavEntry | null;
  /** Drop dead entries (call when nodes/workspaces are deleted). */
  prune: (isLive: IsLive) => void;
  canBack: boolean;
  canForward: boolean;
}

/**
 * React binding for {@link NavHistoryStore}. The store lives in a ref (imperative,
 * survives re-renders, never persisted); `canBack`/`canForward` are mirrored into
 * state so the topbar buttons enable/disable reactively.
 */
export function useNavHistory(): NavHistory {
  const storeRef = useRef<NavHistoryStore | null>(null);
  if (storeRef.current === null) storeRef.current = new NavHistoryStore();
  const store = storeRef.current;

  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  const sync = useCallback(() => {
    setCanBack(store.canBack());
    setCanForward(store.canForward());
  }, [store]);

  const record = useCallback(
    (entry: NavEntry) => {
      if (store.record(entry)) sync();
    },
    [store, sync],
  );

  const back = useCallback(
    (isLive: IsLive) => {
      const target = store.back(isLive);
      sync(); // stacks may have shifted even when target is null (dead entries dropped)
      return target;
    },
    [store, sync],
  );

  const forward = useCallback(
    (isLive: IsLive) => {
      const target = store.forward(isLive);
      sync();
      return target;
    },
    [store, sync],
  );

  const prune = useCallback(
    (isLive: IsLive) => {
      if (store.prune(isLive)) sync();
    },
    [store, sync],
  );

  return { record, back, forward, prune, canBack, canForward };
}
