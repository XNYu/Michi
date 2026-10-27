import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { PaneItem, SourceLocation } from '../../state/paneItems';

export interface FileReadingPosition {
  scrollTop: number;
  scrollLeft: number;
  resolvedFilePath: string;
  modifiedAt: number;
  size: number;
  /** Reference identity distinguishes a fresh explicit navigation request. */
  sourceLocation?: SourceLocation;
}

interface PaneViewState {
  read: (pane: PaneItem, identity: string) => FileReadingPosition | undefined;
  write: (pane: PaneItem, identity: string, position: FileReadingPosition) => void;
}

const PaneViewStateContext = createContext<PaneViewState | null>(null);

/** View-only state survives page unmounts, while the descriptor owns its lifetime.
 * Nothing here retains a renderer, file contents, native resource or disk cache.
 * A closed/replaced pane cannot write its state back during unmount cleanup.
 */
export function PaneViewStateProvider({ items, children }: {
  items: Record<string, PaneItem>; children: React.ReactNode;
}) {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const positions = useRef(new Map<string, { item: PaneItem; views: Map<string, FileReadingPosition> }>());
  useEffect(() => {
    for (const [id, entry] of positions.current) {
      if (!items[id] || items[id].createdAt !== entry.item.createdAt) positions.current.delete(id);
    }
  }, [items]);
  const store = useMemo<PaneViewState>(() => ({
    read: (pane, identity) => {
      const entry = positions.current.get(pane.id);
      return entry?.item.createdAt === pane.createdAt ? entry.views.get(identity) : undefined;
    },
    write: (pane, identity, position) => {
      const id = pane.id;
      const item = itemsRef.current[id];
      if (!item || item.kind !== 'file' || item.createdAt !== pane.createdAt) return;
      let entry = positions.current.get(id);
      if (!entry || entry.item.createdAt !== item.createdAt) {
        entry = { item, views: new Map() };
        positions.current.set(id, entry);
      }
      entry.views.set(identity, position);
      // A FilePane has two view modes. Identity changes must not accumulate
      // abandoned file/backend/scope positions within a long-lived descriptor.
      while (entry.views.size > 2) entry.views.delete(entry.views.keys().next().value!);
    },
  }), []);
  return <PaneViewStateContext.Provider value={store}>{children}</PaneViewStateContext.Provider>;
}

export function usePaneViewState() {
  return useContext(PaneViewStateContext);
}
