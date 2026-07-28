import React, { useEffect, useMemo, useRef, useState } from 'react';
import dagre from '@dagrejs/dagre';
import { useChatStore, useChatNodesSnapshot, useStructuralSelector, chatLabel } from '../../../state/chatStore';
import { sortTrees } from '../../../state/sidebarSelectors';
import { relativeTime } from '../../../lib/relativeTime';
import { Dot } from '../primitives';
import ContextMenu from '../../ContextMenu';
import { visibleMapNodeIds } from './mapVisibility';
import { buildTreeContextMenu } from '../../../lib/treeContextMenu';
import { requestDigest } from '../../../lib/digestPrompt';
import { findTreeIdForNode } from '../../../state/tree';
import { MapTimeline } from '../map/MapTimeline';
import { MapCard } from '../map/MapCard';
import { branchRibbonText } from '../../../state/mapOverviewSelectors';
import { isNodeUnread } from '../../../state/sidebarSelectors';
import Branches from './Branches';
import { MAP_VIEWS, MAP_VIEW_LABELS, type MapView } from './mapView';
import { useElkLayout, elkEdgePathD, type ElkRoutingStyle } from './useElkLayout';
import type { PageId } from '../../../state/commands';
import type { Tree, ProjectEdge } from '../../../state/chatTypes';

// MapCard (DOM) box fed to dagre. Expanding a card reflows the graph — dagre
// reserves the taller box so neighbors slide down to make room (a MODERATE
// amount: CARD_H_EXPANDED tracks the real expanded content so the gap stays
// ≈ NODE_SEP, not a big empty void). Both the cards and the shifted neighbors
// animate to their new positions (see the wrapper's top/left transition).
const CARD_W = 348;
const CARD_H = 118;          // collapsed: heat bar + ASKED strip + title + summary + meta
const CARD_H_EXPANDED = 220; // expanded: + trail + footer (≈ real content height)
const NODE_SEP = 48;         // gap between sibling cards (cross-axis, vertical in LR)
const RANK_SEP = 130;        // gap between ranks (main-axis, horizontal in LR)
const TREE_GAP = 80;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
const FIT_PADDING = 72;

// Glass material shared by the floating zoom pill. Token-based so it stays
// legible across palettes (translucent white on light, dark on dark).
const GLASS_BG = 'color-mix(in srgb, var(--term-surface) 82%, transparent)';
const GLASS_BORDER = '1px solid color-mix(in srgb, var(--term-fg) 8%, transparent)';
const GLASS_SHADOW = '0 12px 36px -18px color-mix(in srgb, var(--term-fg) 35%, transparent)';

type MapMode = 'overview' | 'thread' | 'graph';
type ZoomMode = 'auto' | 'manual';
const DEFAULT_MAP_MODE: MapMode = 'thread';
const EMPTY_TREES: readonly Tree[] = [];

type TreeSummary = {
  tree: Tree;
  ids: string[];
  title: string;
  nodeCount: number;
  messageCount: number;
  splitCount: number;
  leafCount: number;
  streaming: boolean;
  selected: boolean;
  lastActiveAt: number;
};

function truncateByWidth(s: string, maxWidthChars: number): string {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const inc = /[一-鿿＀-￯　-ゟ゠-ヿ]/.test(s[i]) ? 2 : 1;
    if (w + inc > maxWidthChars) return s.slice(0, i) + '…';
    w += inc;
  }
  return s;
}

function collectReachableIds(
  rootId: string,
  children: Map<string, string[]>,
  liveSet: Set<string>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || !liveSet.has(id)) continue;
    seen.add(id);
    ids.push(id);
    for (const c of children.get(id) ?? []) queue.push(c);
  }
  return ids;
}

function isBranchEdge(e: ProjectEdge): boolean {
  return e.kind === undefined || e.kind === 'branch';
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function useStableStringArray(value: string[]): readonly string[] {
  const ref = useRef<readonly string[]>(value);
  if (!sameStringArray(ref.current, value)) ref.current = value;
  return ref.current;
}

function sameLayoutTrees(a: readonly Tree[], b: readonly Tree[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.rootNodeId !== right.rootNodeId ||
      left.createdAt !== right.createdAt ||
      left.archivedAt !== right.archivedAt
    ) {
      return false;
    }
  }
  return true;
}

/** Keep lastActiveAt/name-only tree updates from invalidating graph geometry. */
function useStableLayoutTrees(value: readonly Tree[]): readonly Tree[] {
  const ref = useRef<readonly Tree[]>(value);
  if (!sameLayoutTrees(ref.current, value)) ref.current = value;
  return ref.current;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// Cap how far "fit" is allowed to scale UP the graph. The cards are now
// full-size (232px) so blowing them past 1:1 is what made them fill the screen;
// keep fit at natural size (or below) and let the user zoom in manually.
const MAX_FIT_ZOOM = 1.0;

export default function TerminalMap({ onNav }: { onNav?: (p: PageId) => void } = {}) {
  const {
    activeProject,
    edges,
    openPane,
    toggleSelection,
    clearSelection,
    selection,
    createBlankChild,
    deleteNode,
    trimNode,
    archiveNode,
    createMergedChat,
    createDigest,
    archiveTree,
    activateTree,
  } = useChatStore();
  const nodesSnapshot = useChatNodesSnapshot();
  const streamingIds = useStructuralSelector(
    (ns) => {
      const out = new Set<string>();
      for (const [id, n] of Object.entries(ns)) {
        if (n.status === 'streaming') out.add(id);
      }
      return out;
    },
    (a, b) => {
      if (a === b) return true;
      if (a.size !== b.size) return false;
      for (const id of a) if (!b.has(id)) return false;
      return true;
    },
  );
  const [zoom, setZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('auto');
  // Top-level view (graph / timeline / doc). Session-only, always opens on graph.
  // The switcher floats top-right on the canvas, under the Topbar's icon row.
  const [view, setView] = useState<MapView>('graph');
  // Which graph cards are expanded (in-place, pushes neighbors via dagre). Session-only.
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Layout engine toggle: 'dagre' (default) vs 'elk'.
  // Stored in session state so the user can A/B compare.
  const [layoutEngine, setLayoutEngine] = useState<'dagre' | 'elk'>('elk');
  const [elkRouting, setElkRouting] = useState<ElkRoutingStyle>('ORTHOGONAL');

  // Measured DOM heights for expanded cards. After the card expands and renders,
  // a ResizeObserver reports its actual height. This feeds back into dagre so
  // the layout uses real content height instead of the fixed CARD_H_EXPANDED
  // estimate, guaranteeing NODE_SEP gaps between expanded cards.
  const [measuredHeights, setMeasuredHeights] = useState<Map<string, number>>(new Map());
  const cardRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const expandedSetRef = useRef(expandedSet);
  expandedSetRef.current = expandedSet;
  const roRef = useRef<ResizeObserver | null>(null);
  if (!roRef.current) {
    roRef.current = new ResizeObserver((entries) => {
      let changed = false;
      const updates: [string, number][] = [];
      for (const entry of entries) {
        const el = entry.target as HTMLDivElement;
        const nodeId = el.getAttribute('data-map-node');
        if (!nodeId) continue;
        // Only care about expanded cards — collapsed ones use CARD_H.
        if (!expandedSetRef.current.has(nodeId)) continue;
        const h = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
        if (h > 0) updates.push([nodeId, h]);
      }
      if (updates.length === 0) return;
      setMeasuredHeights((prev) => {
        const next = new Map(prev);
        for (const [nid, h] of updates) {
          if (prev.get(nid) !== h) { next.set(nid, h); changed = true; }
        }
        return changed ? next : prev;
      });
    });
  }
  // Cleanup the ResizeObserver on unmount.
  useEffect(() => () => { roRef.current?.disconnect(); }, []);
  const [mode, setMode] = useState<MapMode>(DEFAULT_MAP_MODE);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // fanout grow-in: ids that appeared since the last render play the grow
  // animation once. `seenIdsRef` is the StrictMode-safe ledger of ids already
  // mounted; the FIRST effect run seeds it with every current node so opening
  // the map never animates the existing tree — only nodes that show up
  // afterwards (agent spawn / branch) grow in.
  const seenIdsRef = useRef<Set<string> | null>(null);
  const growTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [growIds, setGrowIds] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; targetId: string } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  // Drag-to-pan: anchor the pointer's starting client-coords + the
  // container's scroll offset, then on each pointermove we update
  // scrollLeft/Top by the delta. Closed over via ref so the move
  // handler isn't recreated on each render.
  const panRef = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const setMapMode = (nextMode: MapMode) => {
    setMode(nextMode);
    setZoomMode('auto');
  };

  const hasActiveProject = activeProject !== null;
  const projectTrees = activeProject?.trees ?? EMPTY_TREES;
  const layoutTrees = useStableLayoutTrees(projectTrees);
  const activeTreeId = activeProject?.activeTreeId ?? null;

  // The public Map is thread-scoped: only live chats reachable from the
  // active tree root participate in layout, selection, and actions.
  const computedLiveIds = useMemo(
    () => visibleMapNodeIds(activeProject, nodesSnapshot),
    [activeProject, nodesSnapshot],
  );
  const liveIds = useStableStringArray(computedLiveIds);

  const liveSet = useMemo(() => new Set(liveIds), [liveIds]);

  const branchChildren = useMemo(() => {
    const children = new Map<string, string[]>();
    for (const e of edges) {
      if (!isBranchEdge(e)) continue;
      if (!liveSet.has(e.source) || !liveSet.has(e.target)) continue;
      const arr = children.get(e.source) ?? [];
      arr.push(e.target);
      children.set(e.source, arr);
    }
    return children;
  }, [edges, liveSet]);

  const graphChildren = useMemo(() => {
    const children = new Map<string, string[]>();
    for (const e of edges) {
      if (e.kind && e.kind !== 'branch' && e.kind !== 'merge') continue;
      if (!liveSet.has(e.source) || !liveSet.has(e.target)) continue;
      const arr = children.get(e.source) ?? [];
      arr.push(e.target);
      children.set(e.source, arr);
    }
    return children;
  }, [edges, liveSet]);

  // child -> parent (branch edges only), for the hover-ancestor-chain highlight.
  const parentOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of edges) {
      if (!isBranchEdge(e)) continue;
      if (!liveSet.has(e.source) || !liveSet.has(e.target)) continue;
      m.set(e.target, e.source);
    }
    return m;
  }, [edges, liveSet]);

  // Hovered node's ancestor chain (itself + every parent up to the root).
  // null when nothing is hovered — no dimming in that case.
  const ancestorSet = useMemo(() => {
    if (!hoveredId) return null;
    const set = new Set<string>();
    let cur: string | undefined = hoveredId;
    while (cur && !set.has(cur)) {
      set.add(cur);
      cur = parentOf.get(cur);
    }
    return set;
  }, [hoveredId, parentOf]);

  // Merge-source highlight: when hovering a merge node, light up all its
  // source nodes + the merge edges flowing into it.
  const mergeHighlightSet = useMemo(() => {
    if (!hoveredId) return null;
    const node = nodesSnapshot[hoveredId];
    if (!node?.mergeSources?.length) return null;
    return new Set([hoveredId, ...node.mergeSources]);
  }, [hoveredId, nodesSnapshot]);

  const treeSummaries = useMemo<TreeSummary[]>(() => {
    if (!activeProject) return [];
    return sortTrees(activeProject.trees ?? [], activeProject.activeTreeId)
      .filter((tree) => !tree.archivedAt && tree.kind !== 'merge' && liveSet.has(tree.rootNodeId))
      .map((tree) => {
        const ids = collectReachableIds(tree.rootNodeId, branchChildren, liveSet);
        const root = nodesSnapshot[tree.rootNodeId];
        const splitCount = ids.filter((id) => (branchChildren.get(id)?.length ?? 0) > 1).length;
        const leafCount = ids.filter((id) => (branchChildren.get(id)?.length ?? 0) === 0).length;
        const messageCount = ids.reduce((sum, id) => sum + (nodesSnapshot[id]?.messages.length ?? 0), 0);
        return {
          tree,
          ids,
          title: tree.name?.trim() || (root ? (root.title || chatLabel(root)) : '') || 'Untitled thread',
          nodeCount: ids.length,
          messageCount,
          splitCount,
          leafCount,
          streaming: ids.some((id) => streamingIds.has(id)),
          selected: ids.some((id) => selection.has(id)),
          lastActiveAt: tree.lastActiveAt || tree.createdAt,
        };
      });
  }, [activeProject, branchChildren, liveSet, nodesSnapshot, selection, streamingIds]);

  const activeTree = useMemo(() => {
    if (!activeTreeId) return null;
    const tree = layoutTrees.find((item) => item.id === activeTreeId) ?? null;
    return tree && !tree.archivedAt ? tree : null;
  }, [activeTreeId, layoutTrees]);

  const dagreLayout = useMemo(() => {
    if (!hasActiveProject || mode === 'overview') return null;

    const graphTrees = mode === 'thread'
      ? activeTree
        ? [activeTree]
        : []
      : [...layoutTrees]
          .filter((t) => !t.archivedAt && liveSet.has(t.rootNodeId))
          .sort((a, b) => a.createdAt - b.createdAt);

    // Per-tree dagre pass (rankdir LR: root on the left, children fan right).
    // Each tree is placed in its own local coord space; we record the root's
    // local y so we can stack trees vertically below.
    type LaidTree = {
      ids: string[];
      nodeLocal: Map<string, { x: number; y: number }>;
      localMinX: number;
      localMinY: number;
      localMaxY: number;
    };
    const laid: LaidTree[] = [];

    for (const tree of graphTrees) {
      const ids = collectReachableIds(tree.rootNodeId, graphChildren, liveSet);
      if (ids.length === 0) continue;
      const idSet = new Set(ids);

      const g = new dagre.graphlib.Graph();
      g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP });
      g.setDefaultEdgeLabel(() => ({}));
      for (const id of ids) {
        // Expanded cards reserve a taller box so dagre pushes the cross-axis
        // neighbors down just enough to clear the expanded content.
        // Use the measured DOM height when available (after the first render),
        // otherwise fall back to the CARD_H_EXPANDED estimate.
        const h = expandedSet.has(id)
          ? Math.max(CARD_H_EXPANDED, measuredHeights.get(id) ?? CARD_H_EXPANDED)
          : CARD_H;
        g.setNode(id, { width: CARD_W, height: h });
      }
      for (const e of edges) {
        // dagre layout should only follow real parent/child branches.
        // 'link' (cross-tree reference) and 'digest-source' (digest fan-in)
        // are decorative — feeding them as edges yanks roots sideways and
        // pulls digests into the middle of the tree. 'merge' edges keep
        // the synthesize node anchored near its sources.
        if (e.kind && e.kind !== 'branch' && e.kind !== 'merge') continue;
        if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
        g.setEdge(e.source, e.target, { kind: e.kind ?? 'branch' });
      }
      dagre.layout(g);

      const nodeLocal = new Map<string, { x: number; y: number }>();
      let minX = Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const id of ids) {
        const p = g.node(id);
        if (!p) continue;
        nodeLocal.set(id, { x: p.x, y: p.y });
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      laid.push({ ids, nodeLocal, localMinX: minX, localMinY: minY, localMaxY: maxY });
    }

    const PAD = 36;
    if (laid.length === 0) {
      return {
        ids: [],
        positions: new Map<string, { x: number; y: number }>(),
        width: CARD_W + PAD * 2,
        height: CARD_H + PAD * 2,
      };
    }

    // Left edge (root center) shared by every tree; each tree stacks vertically.
    const leftX = PAD + CARD_W / 2;
    const positions = new Map<string, { x: number; y: number }>();
    const ids: string[] = [];
    let cursorY = PAD;
    let maxX = -Infinity;
    for (const t of laid) {
      const offsetY = -t.localMinY + cursorY;
      for (const id of t.ids) {
        const local = t.nodeLocal.get(id);
        if (!local) continue;
        ids.push(id);
        const x = local.x - t.localMinX + leftX;
        const y = local.y + offsetY;
        positions.set(id, { x, y });
        if (x > maxX) maxX = x;
      }
      cursorY += (t.localMaxY - t.localMinY) + CARD_H + TREE_GAP;
    }

    return {
      ids,
      positions,
      width: maxX + CARD_W / 2 + PAD,
      height: cursorY - TREE_GAP + PAD,
    };
    // expandedSet IS a dependency: an expanded card reserves a taller dagre box,
    // so toggling recomputes positions and neighbors slide to make room.
    // measuredHeights refines the estimate once DOM measures are available.
  }, [hasActiveProject, layoutTrees, activeTree, edges, graphChildren, liveSet, mode, expandedSet, measuredHeights]);

  // ELK layout (async). Only runs when layoutEngine === 'elk'.
  const elkResult = useElkLayout({
    enabled: layoutEngine === 'elk',
    trees: layoutTrees,
    activeTree,
    edges,
    liveSet,
    mode,
    expandedSet,
    measuredHeights,
    graphChildren,
    routingStyle: elkRouting,
  });

  // Unified layout: pick the active engine's result.
  // ELK is async so we fall back to dagre while it computes.
  const layout = layoutEngine === 'elk' && elkResult ? elkResult : dagreLayout;

  // Detect freshly-appeared graph nodes → play grow-in once, then drop the flag.
  const layoutIds = layout?.ids;
  useEffect(() => {
    if (!layoutIds) return;
    const current = new Set(layoutIds);
    const seen = seenIdsRef.current;
    if (seen === null) {
      // First pass: adopt the existing tree without animating it.
      seenIdsRef.current = current;
      return;
    }
    const fresh = layoutIds.filter((id) => !seen.has(id));
    for (const id of current) seen.add(id);
    if (fresh.length === 0) return;
    setGrowIds((prev) => {
      const next = new Set(prev);
      for (const id of fresh) next.add(id);
      return next;
    });
    const timers = growTimersRef.current;
    for (const id of fresh) {
      const existing = timers.get(id);
      if (existing) clearTimeout(existing);
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        setGrowIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 720)); // matches map-card-in (0.5s) / edge-draw (0.7s) + a hair
    }
  }, [layoutIds]);

  useEffect(() => {
    const timers = growTimersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);

  useEffect(() => {
    if (mode === 'overview') return;
    const surface = surfaceRef.current;
    if (!surface) return;

    let frame = 0;
    const update = () => {
      const next = {
        width: surface.clientWidth,
        height: surface.clientHeight,
      };
      setSurfaceSize((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next,
      );
    };
    update();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }

    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    });
    observer.observe(surface);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [layout?.height, layout?.width, mode]);

  const fitZoom = useMemo(() => {
    if (!layout || surfaceSize.width <= 0 || surfaceSize.height <= 0) return 1;
    const usableWidth = Math.max(1, surfaceSize.width - FIT_PADDING * 2);
    const usableHeight = Math.max(1, surfaceSize.height - FIT_PADDING * 2);
    // Fit both axes so a wide (deep) tree AND a tall (branchy) tree both settle
    // inside the viewport rather than overflowing on the unconsidered axis.
    const fit = Math.min(usableWidth / layout.width, usableHeight / layout.height);
    return clamp(fit, MIN_ZOOM, MAX_FIT_ZOOM);
  }, [layout, surfaceSize.height, surfaceSize.width]);

  const effectiveZoom = zoomMode === 'auto' ? fitZoom : zoom;
  const zoomOut = () => {
    setZoomMode('manual');
    setZoom(clamp(Math.round((effectiveZoom - 0.1) * 10) / 10, MIN_ZOOM, MAX_ZOOM));
  };
  const zoomIn = () => {
    setZoomMode('manual');
    setZoom(clamp(Math.round((effectiveZoom + 0.1) * 10) / 10, MIN_ZOOM, MAX_ZOOM));
  };
  const fitMap = () => {
    setZoomMode('auto');
  };
  const closeMenuFromMapPointerDown = (event: React.PointerEvent) => {
    if (event.button === 0 && menu) setMenu(null);
  };

  if (!activeProject || !layout) {
    if (activeProject && mode === 'overview') {
      return (
        <MapFrame view={view} setView={setView}>
          <OverviewSurface
            summaries={treeSummaries}
            activeTreeId={activeProject.activeTreeId}
            onOpenThread={(treeId) => {
              activateTree(treeId, activeProject.id);
              setMapMode('thread');
            }}
            onOpenRoot={(nodeId) => {
              openPane(nodeId);
              onNav?.('dashboard');
            }}
            onToggleRootSelection={toggleSelection}
            onPointerDownCapture={closeMenuFromMapPointerDown}
            onContextMenu={(event, nodeId) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, targetId: nodeId });
            }}
          />
          {menu && activeProject && (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              sections={buildTreeContextMenu({
                project: activeProject,
                nodes: nodesSnapshot,
                targetId: menu.targetId,
                selection,
                actions: {
                  openPane,
                  createBlankChild,
                  toggleSelection,
                  clearSelection,
                  deleteNode,
                  trimNode,
                  archiveNode,
                  createMergedChat,
                  createDigest,
                  openExportPanel: () =>
                    window.dispatchEvent(new CustomEvent('michi:toggle-export-panel')),
                  archiveTree,
                  focusOrOpen: (id) => {
                    openPane(id);
                    onNav?.('dashboard');
                  },
                },
              })}
              onClose={() => setMenu(null)}
            />
          )}
        </MapFrame>
      );
    }
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 13,
        }}
      >
        — no workspace —
      </div>
    );
  }

  const streamingCount = liveIds.filter((id) => streamingIds.has(id)).length;
  // Selection is global store state, but the Map action bar must only operate
  // on live nodes visible in this map. This prevents a stale selection from a
  // digest/archived surface from silently joining a merge or export.
  const selectedMapIds = liveIds.filter((id) => selection.has(id));
  const selectedTreeIds = selectedMapIds.map((id) => findTreeIdForNode(id, activeProject));
  const selectionHasStreaming = selectedMapIds.some((id) => streamingIds.has(id));
  const knownSelectedTreeIds = selectedTreeIds.filter((id): id is string => !!id);
  const selectionSpansTrees =
    knownSelectedTreeIds.length !== selectedMapIds.length
    || new Set(knownSelectedTreeIds).size > 1;
  const canMergeSelection =
    selectedMapIds.length >= 2
    && !selectionHasStreaming
    && !selectionSpansTrees;
  const canDigestSelection =
    selectedMapIds.length >= 1
    && !selectionHasStreaming
    && !selectionSpansTrees;

  const mergeSelection = async () => {
    if (!canMergeSelection) return;
    try {
      await createMergedChat(selectedMapIds);
      clearSelection();
      onNav?.('dashboard');
    } catch {
      // createMergedChat already surfaces its validation error as a toast.
    }
  };

  const digestSelection = () => {
    if (!canDigestSelection) return;
    requestDigest(activeProject.id, selectedMapIds);
    clearSelection();
  };

  const exportSelection = () => {
    window.dispatchEvent(
      new CustomEvent('michi:toggle-export-panel', {
        detail: { projectId: activeProject.id, nodeIds: selectedMapIds },
      }),
    );
  };

  const strokeFor = (
    kind: string | undefined,
  ): { stroke: string; dasharray?: string; opacity: number } => {
    switch (kind) {
      case 'merge':
        return { stroke: 'var(--term-mauve)', dasharray: '6 4', opacity: 0.65 };
      case 'link':
        return { stroke: 'var(--term-accent)', dasharray: '2 6', opacity: 0.7 };
      default:
        return { stroke: 'color-mix(in srgb, var(--term-fg) 25%, transparent)', opacity: 1 };
    }
  };

  const scaledWidth = layout.width * effectiveZoom;
  const scaledHeight = layout.height * effectiveZoom;
  const canvasWidth = Math.max(scaledWidth, surfaceSize.width);
  const canvasHeight = Math.max(scaledHeight, surfaceSize.height);
  const nowTs = Date.now();
  const rootNodeId = activeTree?.rootNodeId ?? null;

  return (
    <MapFrame view={view} setView={setView}>
      {view === 'timeline' && (
        <MapTimeline
          nodes={liveIds.map((id) => nodesSnapshot[id]).filter(Boolean)}
          now={Date.now()}
          parentOf={parentOf}
          onOpenPane={(id) => {
            openPane(id);
            onNav?.('dashboard');
          }}
          onFocus={(id) => {
            openPane(id);
            onNav?.('dashboard');
          }}
        />
      )}
      {view === 'doc' && <Branches onNav={onNav} />}
      {view === 'graph' && (
      <div
        onPointerDownCapture={closeMenuFromMapPointerDown}
        style={{ flex: 1, position: 'relative', minHeight: 0 }}
      >
        {/* map surface */}
        <div
          ref={surfaceRef}
          onPointerDown={(e) => {
            // Only start panning on left-click against empty canvas. If the
            // press lands on a node group (or any descendant we care about),
            // bail so click/contextmenu still work on nodes.
            if (e.button !== 0) return;
            const target = e.target as Element;
            if (target.closest('[data-map-node]')) return;
            const surface = surfaceRef.current;
            if (!surface) return;
            panRef.current = {
              x: e.clientX,
              y: e.clientY,
              sx: surface.scrollLeft,
              sy: surface.scrollTop,
            };
            setPanning(true);
            surface.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const start = panRef.current;
            const surface = surfaceRef.current;
            if (!start || !surface) return;
            surface.scrollLeft = start.sx - (e.clientX - start.x);
            surface.scrollTop = start.sy - (e.clientY - start.y);
          }}
          onPointerUp={(e) => {
            if (!panRef.current) return;
            panRef.current = null;
            setPanning(false);
            const surface = surfaceRef.current;
            if (surface && surface.hasPointerCapture(e.pointerId)) {
              surface.releasePointerCapture(e.pointerId);
            }
          }}
          onPointerCancel={() => {
            panRef.current = null;
            setPanning(false);
          }}
          onWheel={(e) => {
            // ⌘/Ctrl + wheel (or trackpad pinch, which browsers report as
            // ctrlKey wheel) zooms; plain wheel keeps scrolling the canvas.
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            setZoomMode('manual');
            setZoom((z) => {
              const base = zoomMode === 'auto' ? fitZoom : z;
              const next = base * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
              return clamp(Math.round(next * 100) / 100, MIN_ZOOM, MAX_ZOOM);
            });
          }}
          style={{
            width: '100%',
            height: '100%',
            overflow: 'auto',
            backgroundImage: 'radial-gradient(color-mix(in srgb, var(--term-line) 55%, var(--term-bg)) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            cursor: panning ? 'grabbing' : 'grab',
            // Block native text selection while dragging — a stray drag would
            // otherwise paint a selection rectangle across node labels.
            userSelect: panning ? 'none' : undefined,
          }}
        >
          <div
            style={{
              width: canvasWidth || scaledWidth,
              height: canvasHeight || scaledHeight,
              minWidth: '100%',
              minHeight: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* Scaled canvas: SVG draws edges, DOM layer draws MapCards. Both
                share one transform so pan/zoom stay aligned. The outer box
                reserves the *scaled* footprint so the scroll container can pan;
                the inner box is scaled from its top-left origin. */}
            <div style={{ position: 'relative', width: scaledWidth, height: scaledHeight, flexShrink: 0 }}>
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: layout.width,
                height: layout.height,
                transform: `scale(${effectiveZoom})`,
                transformOrigin: '0 0',
              }}
            >
            <svg
              width={layout.width}
              height={layout.height}
              style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
            >
              {edges.map((e, i) => {
                const src = layout.positions.get(e.source);
                const tgt = layout.positions.get(e.target);
                // Digest endpoints are absent from `positions` (digests are
                // hidden from the map), so digest-source edges drop out here.
                if (!src || !tgt) return null;
                // Card width is fixed (expansion only grows height, as an
                // overlay), so edges anchor to the constant collapsed box.
                // LR: leave the parent's right edge, enter the child's left edge.
                const sx = src.x + CARD_W / 2;
                const sy = src.y;
                const tx = tgt.x - CARD_W / 2;
                const ty = tgt.y;
                const dx = Math.max(42, (tx - sx) * 0.5);

                // ELK edge routing: use computed bend points when available.
                const elkEdgeKey = `${e.source}->${e.target}`;
                const elkRoute = layoutEngine === 'elk' && elkResult?.edgeRoutes?.get(elkEdgeKey);
                const pathD = elkRoute
                  ? elkEdgePathD(elkRoute.sections, src, tgt, elkRouting)
                  : `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;

                const streamingEdge = streamingIds.has(e.target);
                const growEdge = isBranchEdge(e) && growIds.has(e.target);
                // Ancestor-chain highlight: an edge lights only when BOTH its
                // endpoints are on the hovered node's chain.
                const ancEdge = ancestorSet != null
                  && ancestorSet.has(e.source) && ancestorSet.has(e.target);
                // Merge-source highlight: a merge edge lights when hovering
                // the merge target and its source is in the highlight set.
                const mergeEdge = e.kind === 'merge'
                  && mergeHighlightSet != null
                  && mergeHighlightSet.has(e.source) && mergeHighlightSet.has(e.target);
                const dimEdge = ancestorSet != null && !ancEdge && !mergeEdge;
                const { stroke, dasharray, opacity } = strokeFor(e.kind);
                const litStroke = streamingEdge || ancEdge || mergeEdge;
                const edgeClass = [
                  streamingEdge ? 'map-edge--flow' : '',
                  growEdge ? 'map-edge--draw' : '',
                ].filter(Boolean).join(' ') || undefined;
                return (
                  <path
                    key={i}
                    className={edgeClass}
                    d={pathD}
                    stroke={mergeEdge ? 'var(--term-mauve)' : litStroke ? 'var(--term-accent)' : stroke}
                    strokeWidth={litStroke ? 1.8 : 1.4}
                    strokeLinecap="round"
                    strokeDasharray={streamingEdge || mergeEdge ? undefined : growEdge ? undefined : dasharray}
                    fill="none"
                    opacity={dimEdge ? opacity * 0.3 : opacity}
                    style={{ transition: 'opacity .16s, stroke .16s' }}
                  />
                );
              })}
            </svg>
            {layout.ids.map((id) => {
              const n = nodesSnapshot[id];
              if (!n) return null;
              const pos = layout.positions.get(id);
              if (!pos) return null;
              const exp = expandedSet.has(id);
              // Wrapper uses dagre's allocated height (which incorporates the
              // measured DOM height for expanded cards, falling back to the
              // estimate). This keeps the card centered on dagre's pos.y.
              const w = CARD_W;
              const h = exp
                ? Math.max(CARD_H_EXPANDED, measuredHeights.get(id) ?? CARD_H_EXPANDED)
                : CARD_H;
              const sel = selection.has(id);
              const onMap = view === 'graph';
              return (
                <div
                  key={id}
                  data-map-node={id}
                  ref={(el) => {
                    const ro = roRef.current!;
                    const prev = cardRefsMap.current.get(id);
                    if (prev && prev !== el) { ro.unobserve(prev); }
                    if (el) { cardRefsMap.current.set(id, el); ro.observe(el); }
                    else { cardRefsMap.current.delete(id); }
                  }}
                  onMouseEnter={onMap ? () => setHoveredId(id) : undefined}
                  onMouseLeave={onMap ? () => setHoveredId((h) => (h === id ? null : h)) : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) {
                      toggleSelection(id);
                    } else {
                      toggleExpanded(id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, targetId: id });
                  }}
                  style={{
                    position: 'absolute',
                    left: pos.x - w / 2,
                    top: pos.y - h / 2,
                    width: w,
                    // Animation #2: when expand/collapse reflows the layout, each
                    // card slides to its new position instead of jumping. Keep
                    // the expanded card (and the hovered one) above neighbors so
                    // any transient overlap during the slide reads cleanly.
                    // Hover/expand raises above neighbors so content reads
                    // cleanly during animated reflows.
                    zIndex: exp ? 10 : hoveredId === id ? 5 : undefined,
                    transition: 'top .24s cubic-bezier(.4,0,.2,1), left .24s cubic-bezier(.4,0,.2,1)',
                    outline: sel ? '2px solid var(--term-select)' : undefined,
                    outlineOffset: 2,
                  }}
                >
                  <MapCard
                    node={n}
                    ribbon={branchRibbonText(n)}
                    now={nowTs}
                    expanded={exp}
                    unread={isNodeUnread(n, null)}
                    anc={ancestorSet != null && ancestorSet.has(id)}
                    dim={ancestorSet != null && !ancestorSet.has(id) && !(mergeHighlightSet != null && mergeHighlightSet.has(id))}
                    grow={growIds.has(id)}
                    isMain={id === rootNodeId}
                    mergeSource={mergeHighlightSet != null && mergeHighlightSet.has(id) && id !== hoveredId}
                    onOpenPane={() => {
                      openPane(id);
                      if (n.kind === 'digest') {
                        window.dispatchEvent(
                          new CustomEvent('michi:focus-digest', { detail: { nodeId: id } }),
                        );
                        onNav?.('digest');
                      } else {
                        onNav?.('dashboard');
                      }
                    }}
                  />
                </div>
              );
            })}
            </div>
            </div>
          </div>
        </div>

        {/* Floating zoom pill — graph view only, bottom-right. */}
        <ZoomPill
          zoom={effectiveZoom}
          auto={zoomMode === 'auto'}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onFit={fitMap}
        />

        {/* Layout engine toggle — bottom-left, for A/B comparison. */}
        <LayoutEnginePill
          engine={layoutEngine}
          routing={elkRouting}
          onToggleEngine={() => setLayoutEngine((e) => (e === 'dagre' ? 'elk' : 'dagre'))}
          onSetRouting={setElkRouting}
        />

        {selectedMapIds.length > 0 && (
          <MapSelectionBar
            count={selectedMapIds.length}
            names={selectedMapIds.map((id) => nodesSnapshot[id]?.title || id)}
            canMerge={canMergeSelection}
            canDigest={canDigestSelection}
            selectionHasStreaming={selectionHasStreaming}
            selectionSpansTrees={selectionSpansTrees}
            onMerge={mergeSelection}
            onDigest={digestSelection}
            onExport={exportSelection}
            onClear={clearSelection}
          />
        )}
      </div>
      )}
      {menu && view === 'graph' && activeProject && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          sections={buildTreeContextMenu({
            project: activeProject,
            nodes: nodesSnapshot,
            targetId: menu.targetId,
            selection,
            actions: {
              openPane,
              createBlankChild,
              toggleSelection,
              clearSelection,
              deleteNode,
              trimNode,
              archiveNode,
              createMergedChat,
              createDigest,
              openExportPanel: () =>
                window.dispatchEvent(new CustomEvent('michi:toggle-export-panel')),
              archiveTree,
              focusOrOpen: (id) => {
                openPane(id);
                // After Weave / digest creation we want to land in the chat
                // view, not stay on the map — the user just kicked off a new
                // thread and the next action belongs in dashboard.
                onNav?.('dashboard');
              },
            },
          })}
          onClose={() => setMenu(null)}
        />
      )}
    </MapFrame>
  );
}

function ZoomPill({
  zoom,
  auto,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  zoom: number;
  auto: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  const btn: React.CSSProperties = {
    width: 28, height: 28, display: 'grid', placeItems: 'center', border: 'none',
    background: 'transparent', color: 'var(--term-mid)', cursor: 'pointer', fontSize: 14,
    fontFamily: 'var(--message-code-font)',
  };
  return (
    <div
      style={{
        position: 'absolute', right: 18, bottom: 18,
        display: 'flex', alignItems: 'center',
        background: GLASS_BG,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: GLASS_BORDER,
        boxShadow: GLASS_SHADOW,
      }}
    >
      <button type="button" style={btn} onClick={onZoomOut} title="zoom out"
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--term-alt)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>−</button>
      <span style={{
        fontFamily: 'var(--message-code-font)', fontSize: 10.5, color: 'var(--term-fg)',
        minWidth: 40, textAlign: 'center',
      }}>{Math.round(zoom * 100)}%</span>
      <button type="button" style={btn} onClick={onZoomIn} title="zoom in"
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--term-alt)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>+</button>
      <button
        type="button"
        onClick={onFit}
        title="fit map to the visible area"
        style={{
          border: 'none', borderLeft: GLASS_BORDER, background: 'transparent',
          padding: '0 12px', height: 28, cursor: 'pointer',
          fontFamily: 'var(--message-code-font)', fontSize: 10, letterSpacing: '.08em',
          color: auto ? 'var(--term-accent)' : 'var(--term-mid)',
        }}
      >FIT</button>
    </div>
  );
}

function LayoutEnginePill({
  engine,
  routing,
  onToggleEngine,
  onSetRouting,
}: {
  engine: string;
  routing: ElkRoutingStyle;
  onToggleEngine: () => void;
  onSetRouting: (r: ElkRoutingStyle) => void;
}) {
  const btn: React.CSSProperties = {
    border: 'none',
    background: 'transparent',
    padding: '4px 10px',
    fontFamily: 'var(--message-code-font)',
    fontSize: 10,
    letterSpacing: '.06em',
    cursor: 'pointer',
    height: 28,
  };
  const routingOptions: ElkRoutingStyle[] = ['SPLINES', 'POLYLINE', 'ORTHOGONAL'];
  return (
    <div
      style={{
        position: 'absolute',
        left: 18,
        bottom: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        background: GLASS_BG,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: GLASS_BORDER,
        boxShadow: GLASS_SHADOW,
      }}
    >
      <button
        type="button"
        onClick={onToggleEngine}
        title="Toggle layout engine (dagre ↔ ELK)"
        style={{
          ...btn,
          color: engine === 'elk' ? 'var(--term-accent)' : 'var(--term-mid)',
          fontWeight: engine === 'elk' ? 700 : 450,
        }}
      >
        {engine === 'elk' ? 'ELK' : 'DAGRE'}
      </button>
      {engine === 'elk' && (
        <>
          <span style={{ width: 1, height: 16, background: 'var(--term-line)' }} />
          {routingOptions.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onSetRouting(r)}
              style={{
                ...btn,
                color: routing === r ? 'var(--term-accent)' : 'var(--term-mid)',
                fontWeight: routing === r ? 700 : 400,
                fontSize: 9,
              }}
            >
              {r === 'SPLINES' ? 'spline' : r === 'POLYLINE' ? 'poly' : 'ortho'}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

export function MapSelectionBar({
  count,
  names,
  canMerge,
  canDigest,
  selectionHasStreaming,
  selectionSpansTrees,
  onMerge,
  onDigest,
  onExport,
  onClear,
}: {
  count: number;
  names: string[];
  canMerge: boolean;
  canDigest: boolean;
  selectionHasStreaming: boolean;
  selectionSpansTrees: boolean;
  onMerge: () => void;
  onDigest: () => void;
  onExport: () => void;
  onClear: () => void;
}) {
  const actionStyle = (enabled: boolean): React.CSSProperties => ({
    border: '1px solid color-mix(in srgb, var(--term-surface) 42%, transparent)',
    background: enabled ? 'var(--term-surface)' : 'transparent',
    color: enabled ? 'var(--term-fg)' : 'var(--term-faint)',
    padding: '3px 9px',
    font: 'inherit',
    fontWeight: 600,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.62,
  });
  const digestTitle = selectionHasStreaming
    ? 'Wait for streaming to finish before creating a digest.'
    : selectionSpansTrees
      ? 'Digest requires nodes from a single thread.'
      : 'Create a digest from the selected nodes.';
  const mergeTitle = selectionHasStreaming
    ? 'Wait for streaming to finish before merging.'
    : selectionSpansTrees
      ? 'Merge requires nodes from a single thread.'
    : count < 2
      ? 'Select at least two nodes to merge.'
      : 'Merge selected nodes into a new thread.';

  return (
    <div
      role="toolbar"
      aria-label="Map selection actions"
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 14,
        background: 'var(--term-fg)',
        color: 'var(--term-surface)',
        padding: '8px 10px 8px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11.5,
        boxShadow: '0 8px 24px color-mix(in srgb, var(--term-fg) 22%, transparent)',
      }}
    >
      <span
        style={{
          background: 'var(--term-select)',
          color: 'var(--term-fg)',
          padding: '2px 8px',
          fontWeight: 700,
        }}
      >
        {count}
      </span>
      <span style={{ letterSpacing: '.04em' }}>SELECTED</span>
      <span style={{ color: 'var(--term-faint)' }}>·</span>
      <span
        title={names.join(', ')}
        style={{
          fontFamily: 'var(--ui-font)',
          color: 'var(--term-alt)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}
      >
        {names.join(', ')}
      </span>
      <button type="button" disabled={!canMerge} title={mergeTitle} onClick={onMerge} style={actionStyle(canMerge)}>
        Merge
      </button>
      <button type="button" disabled={!canDigest} title={digestTitle} onClick={onDigest} style={actionStyle(canDigest)}>
        Digest
      </button>
      <button type="button" onClick={onExport} style={actionStyle(true)}>
        Export
      </button>
      <button type="button" onClick={onClear} style={actionStyle(true)}>
        Clear
      </button>
    </div>
  );
}

/** The Map page canvas frame: the paper field behind whichever view is active,
 *  plus the floating Graph/Timeline/Doc switcher anchored top-right — sitting
 *  just under the Topbar's icon row (back / MAP / title stay in the Topbar). */
function MapFrame({
  children,
  view,
  setView,
}: {
  children: React.ReactNode;
  view: MapView;
  setView: (view: MapView) => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: 'relative',
        background: 'color-mix(in srgb, var(--term-bg) 60%, var(--term-surface))',
        overflow: 'hidden',
      }}
    >
      <div
        role="tablist"
        aria-label="Map views"
        style={{
          position: 'absolute',
          top: 8,
          right: 14,
          zIndex: 20,
          display: 'flex',
          background: GLASS_BG,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: GLASS_BORDER,
          boxShadow: GLASS_SHADOW,
          padding: 2,
        }}
      >
        {MAP_VIEWS.map((v) => {
          const active = v === view;
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setView(v)}
              style={{
                border: 'none',
                padding: '4px 14px',
                fontFamily: 'var(--ui-font)',
                fontSize: 11.5,
                color: active ? 'var(--term-bg)' : 'var(--term-mid)',
                background: active ? 'var(--term-fg)' : 'transparent',
                fontWeight: active ? 600 : 450,
                cursor: active ? 'default' : 'pointer',
                transition: 'background .18s',
              }}
            >
              {MAP_VIEW_LABELS[v]}
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}

function OverviewSurface({
  summaries,
  activeTreeId,
  onOpenThread,
  onOpenRoot,
  onToggleRootSelection,
  onPointerDownCapture,
  onContextMenu,
}: {
  summaries: TreeSummary[];
  activeTreeId: string | null;
  onOpenThread: (treeId: string) => void;
  onOpenRoot: (nodeId: string) => void;
  onToggleRootSelection: (nodeId: string) => void;
  onPointerDownCapture: (event: React.PointerEvent) => void;
  onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
}) {
  return (
    <div
      onPointerDownCapture={onPointerDownCapture}
      style={{
        flex: 1,
        overflow: 'auto',
        backgroundImage: 'radial-gradient(color-mix(in srgb, var(--term-line) 55%, var(--term-bg)) 1px, transparent 1px)',
        backgroundSize: '20px 20px',
        minHeight: 0,
        padding: 18,
      }}
    >
      {summaries.length === 0 ? (
        <div
          style={{
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--term-muted)',
            fontSize: 13,
          }}
        >
          no live threads
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 12,
            alignItems: 'stretch',
          }}
        >
          {summaries.map((summary) => {
            const active = summary.tree.id === activeTreeId;
            const title = truncateByWidth(summary.title, 42);
            return (
              <div
                key={summary.tree.id}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) {
                    onToggleRootSelection(summary.tree.rootNodeId);
                    return;
                  }
                  onOpenThread(summary.tree.id);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  onOpenRoot(summary.tree.rootNodeId);
                }}
                onContextMenu={(event) => onContextMenu(event, summary.tree.rootNodeId)}
                style={{
                  minHeight: 132,
                  border: active
                    ? '1px solid var(--term-accent)'
                    : summary.selected
                      ? '1px solid var(--term-select)'
                      : '1px solid var(--term-line)',
                  background: active ? 'var(--term-alt)' : 'var(--term-surface)',
                  boxShadow: active ? 'inset 3px 0 0 var(--term-accent)' : undefined,
                  padding: '12px 13px 11px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      color: active ? 'var(--term-accent)' : 'var(--term-muted)',
                      fontSize: 10,
                      letterSpacing: '.12em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {summary.tree.kind === 'merge' ? 'merge thread' : summary.tree.archivedAt ? 'archived' : 'thread'}
                  </span>
                  {summary.tree.pinnedAt && (
                    <span style={{ color: 'var(--term-pin, var(--term-accent))', fontSize: 11 }}>
                      pinned
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  {summary.streaming && <Dot color="var(--term-select)" size={6} pulse />}
                  <span style={{ color: 'var(--term-muted)', fontSize: 11 }}>
                    {relativeTime(summary.lastActiveAt)}
                  </span>
                </div>
                <div
                  title={summary.title}
                  style={{
                    color: 'var(--term-fg)',
                    fontSize: 15,
                    lineHeight: 1.25,
                    fontWeight: 700,
                    fontFamily: 'var(--ui-font)',
                    minHeight: 38,
                  }}
                >
                  {title}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                    border: '1px solid var(--term-line)',
                    background: 'var(--term-bg)',
                  }}
                >
                  <Metric label="nodes" value={summary.nodeCount} />
                  <Metric label="msgs" value={summary.messageCount} />
                  <Metric label="splits" value={summary.splitCount} />
                  <Metric label="leaves" value={summary.leafCount} />
                </div>
                <div
                  style={{
                    height: 16,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    color: 'var(--term-muted)',
                    fontSize: 10,
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 1,
                      background: active ? 'var(--term-accent)' : 'var(--term-line-s)',
                    }}
                  />
                  <span>{summary.nodeCount === 1 ? 'single node' : 'open thread map'}</span>
                  <div style={{ flex: 1 }} />
                  {summary.selected && <span style={{ color: 'var(--term-select)' }}>selected</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: '6px 7px',
        borderRight: label === 'leaves' ? 'none' : '1px solid var(--term-line)',
        minWidth: 0,
      }}
    >
      <div style={{ color: 'var(--term-fg)', fontSize: 14, fontWeight: 700 }}>{value}</div>
      <div
        style={{
          color: 'var(--term-muted)',
          fontSize: 9,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
    </div>
  );
}
