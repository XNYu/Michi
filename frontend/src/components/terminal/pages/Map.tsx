import React, { useEffect, useMemo, useRef, useState } from 'react';
import dagre from '@dagrejs/dagre';
import { useChatStore, useChatNodesSnapshot, useStructuralSelector, chatLabel } from '../../../state/chatStore';
import { sortTrees } from '../../../state/sidebarSelectors';
import { relativeTime } from '../../../lib/relativeTime';
import { Dot, Tag } from '../primitives';
import ContextMenu from '../../ContextMenu';
import { visibleMapNodeIds } from './mapVisibility';
import { buildTreeContextMenu } from '../../../lib/treeContextMenu';
import { requestDigest } from '../../../lib/digestPrompt';
import { findTreeIdForNode } from '../../../state/tree';
import { MapTimeline } from '../map/MapTimeline';
import Branches from './Branches';
import type { PageId } from '../../../state/commands';
import type { Tree, ProjectEdge } from '../../../state/chatTypes';

const NODE_W = 240;
const NODE_H = 36;
const ROW_GAP = 24;
const COL_GAP = 60;
const TREE_GAP = 64;
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 3;
const FIT_PADDING = 48;

type MapMode = 'overview' | 'thread' | 'graph';
type ZoomMode = 'auto' | 'manual';
/** Three top-level views inside the Map page: the dagre graph, the timeline,
 *  and the Branches document. Not persisted — always opens on 'graph'. */
type MapView = 'graph' | 'timeline' | 'doc';
const MAP_VIEWS: readonly MapView[] = ['graph', 'timeline', 'doc'];
const MAP_VIEW_LABELS: Record<MapView, string> = { graph: '图', timeline: '时间线', doc: '文档' };
const DEFAULT_MAP_MODE: MapMode = 'thread';
const EMPTY_TREES: readonly Tree[] = [];
// Workspace-wide overview/graph code remains available internally, but the
// public Map surface is intentionally scoped to the active thread.
const VISIBLE_MAP_MODES: readonly MapMode[] = ['thread'];

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

function maxFitZoom(nodeCount: number): number {
  if (nodeCount <= 1) return 2.2;
  if (nodeCount <= 3) return 1.9;
  if (nodeCount <= 8) return 1.45;
  return 1.15;
}

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
  const [view, setView] = useState<MapView>('graph');
  const [mode, setMode] = useState<MapMode>(DEFAULT_MAP_MODE);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
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

  const treeSummaries = useMemo<TreeSummary[]>(() => {
    if (!activeProject) return [];
    return sortTrees(activeProject.trees ?? [], activeProject.activeTreeId)
      .filter((tree) => !tree.archivedAt && liveSet.has(tree.rootNodeId))
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

  const layout = useMemo(() => {
    if (!hasActiveProject || mode === 'overview') return null;

    const graphTrees = mode === 'thread'
      ? activeTree
        ? [activeTree]
        : []
      : [...layoutTrees]
          .filter((t) => !t.archivedAt && liveSet.has(t.rootNodeId))
          .sort((a, b) => a.createdAt - b.createdAt);

    // Per-tree dagre pass. Each tree is placed in its own local coord space; we
    // record the root's local x so we can align every tree's root onto a shared
    // vertical centerline below.
    type LaidTree = {
      ids: string[];
      nodeLocal: Map<string, { x: number; y: number }>;
      rootLocalX: number;
      localMinY: number;
      localMaxY: number;
      leftExtent: number; // distance from root center to leftmost rect edge
      rightExtent: number; // distance from root center to rightmost rect edge
    };
    const laid: LaidTree[] = [];

    for (const tree of graphTrees) {
      const ids = collectReachableIds(tree.rootNodeId, graphChildren, liveSet);
      if (ids.length === 0) continue;
      const idSet = new Set(ids);

      const g = new dagre.graphlib.Graph();
      g.setGraph({ rankdir: 'TB', nodesep: ROW_GAP, ranksep: COL_GAP });
      g.setDefaultEdgeLabel(() => ({}));
      for (const id of ids) g.setNode(id, { width: NODE_W, height: NODE_H });
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
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const id of ids) {
        const p = g.node(id);
        if (!p) continue;
        nodeLocal.set(id, { x: p.x, y: p.y });
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const rootLocalX = nodeLocal.get(tree.rootNodeId)?.x ?? (minX + maxX) / 2;
      laid.push({
        ids,
        nodeLocal,
        rootLocalX,
        localMinY: minY,
        localMaxY: maxY,
        leftExtent: rootLocalX - minX + NODE_W / 2,
        rightExtent: maxX - rootLocalX + NODE_W / 2,
      });
    }

    const PAD = 30;
    if (laid.length === 0) {
      return {
        ids: [],
        positions: new Map<string, { x: number; y: number }>(),
        width: NODE_W + PAD * 2,
        height: NODE_H + PAD * 2,
      };
    }

    const maxLeft = laid.reduce((m, t) => Math.max(m, t.leftExtent), NODE_W / 2);
    const maxRight = laid.reduce((m, t) => Math.max(m, t.rightExtent), NODE_W / 2);
    const centerX = PAD + maxLeft;
    const width = centerX + maxRight + PAD;

    const positions = new Map<string, { x: number; y: number }>();
    const ids: string[] = [];
    let cursorY = PAD;
    for (const t of laid) {
      const offsetY = -t.localMinY + cursorY;
      for (const id of t.ids) {
        const local = t.nodeLocal.get(id);
        if (!local) continue;
        ids.push(id);
        positions.set(id, {
          x: local.x - t.rootLocalX + centerX,
          y: local.y + offsetY,
        });
      }
      cursorY += (t.localMaxY - t.localMinY) + NODE_H + TREE_GAP;
    }

    return {
      ids,
      positions,
      width,
      height: cursorY - TREE_GAP + PAD,
    };
  }, [hasActiveProject, layoutTrees, activeTree, edges, graphChildren, liveSet, mode]);

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
    const fit = usableWidth / layout.width;
    return clamp(fit, MIN_ZOOM, maxFitZoom(layout.ids.length));
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
        <MapFrame
          liveNodeCount={liveIds.length}
          mode={mode}
          setMode={setMapMode}
          view={view}
          setView={setView}
          zoom={effectiveZoom}
          zoomMode={zoomMode}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onFit={fitMap}
          showZoom={false}
        >
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
        return { stroke: 'var(--term-line-s)', opacity: 1 };
    }
  };

  const scaledWidth = layout.width * effectiveZoom;
  const scaledHeight = layout.height * effectiveZoom;
  const canvasWidth = Math.max(scaledWidth, surfaceSize.width);
  const canvasHeight = Math.max(scaledHeight, surfaceSize.height);

  return (
    <MapFrame
      liveNodeCount={liveIds.length}
      mode={mode}
      setMode={setMapMode}
      view={view}
      setView={setView}
      zoom={effectiveZoom}
      zoomMode={zoomMode}
      onZoomIn={zoomIn}
      onZoomOut={zoomOut}
      onFit={fitMap}
      streamingCount={streamingCount}
      showZoom={view === 'graph'}
    >
      {view === 'timeline' && (
        <MapTimeline
          nodes={liveIds.map((id) => nodesSnapshot[id]).filter(Boolean)}
          now={Date.now()}
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
      <>
      <div
        style={{
          height: 28,
          borderBottom: '1px solid var(--term-line)',
          background: 'var(--term-alt)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 14px',
          gap: 18,
          fontSize: 10,
          color: 'var(--term-muted)',
          flexShrink: 0,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <svg width={18} height={4}>
            <line x1={0} y1={2} x2={18} y2={2} stroke="var(--term-line-s)" strokeWidth={1.4} />
          </svg>
          branch
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <svg width={18} height={4}>
            <line
              x1={0}
              y1={2}
              x2={18}
              y2={2}
              stroke="var(--term-mauve)"
              strokeWidth={1.4}
              strokeDasharray="6 4"
            />
          </svg>
          merge
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <svg width={18} height={4}>
            <line
              x1={0}
              y1={2}
              x2={18}
              y2={2}
              stroke="var(--term-accent)"
              strokeWidth={1.4}
              strokeDasharray="2 6"
            />
          </svg>
          link
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Dot color="var(--term-select)" size={6} pulse /> streaming
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              width: 10,
              height: 10,
              background: 'var(--term-select-f)',
              border: '1px solid var(--term-select)',
            }}
          />
          selected
        </span>
      </div>

      <div
        onPointerDownCapture={closeMenuFromMapPointerDown}
        style={{
          flex: 1,
          position: 'relative',
          minHeight: 0,
        }}
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
          style={{
            width: '100%',
            height: '100%',
            overflow: 'auto',
            background: 'var(--term-bg)',
            backgroundImage: 'radial-gradient(var(--term-line) 1px, transparent 1px)',
            backgroundSize: '16px 16px',
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
            <svg
              width={scaledWidth}
              height={scaledHeight}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
            >
              {edges.map((e, i) => {
                const src = layout.positions.get(e.source);
                const tgt = layout.positions.get(e.target);
                // Digest endpoints are absent from `positions` (digests are
                // hidden from the map), so digest-source edges drop out here.
                if (!src || !tgt) return null;
                const sx = src.x;
                const sy = src.y + NODE_H / 2;
                const tx = tgt.x;
                const ty = tgt.y - NODE_H / 2;
                const midY = (sy + ty) / 2;
                const { stroke, dasharray, opacity } = strokeFor(e.kind);
                return (
                  <path
                    key={i}
                    d={`M${sx},${sy} C${sx},${midY} ${tx},${midY} ${tx},${ty}`}
                    stroke={stroke}
                    strokeWidth={1.2}
                    strokeDasharray={dasharray}
                    fill="none"
                    opacity={opacity}
                  />
                );
              })}

              {layout.ids.map((id, index) => {
                const n = nodesSnapshot[id];
                if (!n) return null;
                const pos = layout.positions.get(id);
                if (!pos) return null;
                const x = pos.x - NODE_W / 2;
                const y = pos.y - NODE_H / 2;
                // Map view shows the global graph — never paint a "focused" ring
                // for the active pane, that signal belongs in dashboard.
                const focused = false;
                const sel = selection.has(id);
                const streaming = streamingIds.has(id);
                const isDigest = n.kind === 'digest';
                const bg = isDigest
                  ? 'var(--term-digest-f)'
                  : 'var(--term-surface)';
                const fg = isDigest
                  ? 'var(--term-digest)'
                  : 'var(--term-fg)';
                const title = n.title || chatLabel(n) || id;
                const titleX = x + (isDigest ? 22 : 10);
                const titleW = NODE_W - (isDigest ? 32 : 20);
                return (
                  <g
                    key={id}
                    data-map-node={id}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) {
                        toggleSelection(id);
                      } else {
                        openPane(id);
                        if (isDigest) {
                          window.dispatchEvent(
                            new CustomEvent('michi:focus-digest', { detail: { nodeId: id } }),
                          );
                          onNav?.('digest');
                        } else {
                          onNav?.('dashboard');
                        }
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, targetId: id });
                    }}
                    onMouseEnter={() => setHoveredId(id)}
                    onMouseLeave={() => setHoveredId(null)}
                    style={{
                      cursor: 'pointer',
                      animation: 'tMapNodeIn 180ms ease-out both',
                      animationDelay: `${Math.min(index * 20, 400)}ms`,
                    }}
                  >
                    <title>{title}</title>
                    {sel && (
                      <rect
                        x={x - 3}
                        y={y - 3}
                        width={NODE_W + 6}
                        height={NODE_H + 6}
                        fill="var(--term-select-f)"
                        stroke="var(--term-select)"
                        strokeWidth={1.5}
                      />
                    )}
                    <rect
                      x={x}
                      y={y}
                      width={NODE_W}
                      height={NODE_H}
                      fill={bg}
                      stroke={focused ? 'var(--term-fg)' : hoveredId === id ? 'var(--term-accent)' : (isDigest ? 'var(--term-digest)' : 'var(--term-line-s)')}
                      strokeWidth={focused ? 3 : hoveredId === id ? 2 : 1}
                    />
                    {isDigest && (
                      <rect x={x} y={y} width={3} height={NODE_H} fill="var(--term-digest)" />
                    )}
                    {streaming && (
                      <circle cx={x + NODE_W - 10} cy={y + NODE_H / 2} r={3.5} fill="var(--term-select)">
                        <animate
                          attributeName="opacity"
                          values="1;0.3;1"
                          dur="1.1s"
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}
                    {isDigest && (
                      <text
                        x={x + 10}
                        y={y + 14}
                        fontSize={10}
                        fontFamily="var(--ui-font)"
                        fill="var(--term-digest)"
                      >
                        §
                      </text>
                    )}
                    <foreignObject x={titleX} y={y + 4} width={titleW} height={17}>
                      <div
                        style={{
                          color: fg,
                          fontFamily: 'var(--ui-font)',
                          fontSize: 12,
                          fontWeight: focused || isDigest ? 600 : 400,
                          height: 17,
                          lineHeight: '17px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          width: '100%',
                        }}
                      >
                        {title}
                      </div>
                    </foreignObject>
                    <text
                      x={x + 8}
                      y={y + 28}
                      fontSize={8.5}
                      fontFamily="var(--ui-font)"
                      fill={isDigest ? 'var(--term-digest)' : 'var(--term-muted)'}
                    >
                      {n.messages.length} msg
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

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
      </>
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

function MapFrame({
  children,
  liveNodeCount,
  mode,
  setMode,
  view,
  setView,
  zoom,
  zoomMode,
  onZoomIn,
  onZoomOut,
  onFit,
  streamingCount = 0,
  showZoom,
}: {
  children: React.ReactNode;
  liveNodeCount: number;
  mode: MapMode;
  setMode: (mode: MapMode) => void;
  view: MapView;
  setView: (view: MapView) => void;
  zoom: number;
  zoomMode: ZoomMode;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  streamingCount?: number;
  showZoom: boolean;
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          height: 36,
          borderBottom: '1px solid var(--term-line)',
          background: 'var(--term-surface)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 14px',
          gap: 14,
          fontSize: 11,
          flexShrink: 0,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      >
        <span style={{ color: 'var(--term-fg)', fontWeight: 600 }}>{liveNodeCount} nodes</span>
        {streamingCount > 0 && (
          <>
            <span style={{ color: 'var(--term-muted)' }}>·</span>
            <span style={{ color: 'var(--term-select)' }}>{streamingCount} streaming</span>
          </>
        )}
        <div style={{ flex: 1 }} />
        {showZoom && (
          <>
            <span style={{ color: 'var(--term-mid)' }}>zoom</span>
            <div
              style={{
                display: 'flex',
                border: '1px solid var(--term-line)',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
            >
              <span
                onClick={onZoomOut}
                style={{
                  padding: '3px 8px',
                  borderRight: '1px solid var(--term-line)',
                  color: 'var(--term-mid)',
                  cursor: 'pointer',
                }}
              >
                -
              </span>
              <span
                style={{
                  padding: '3px 10px',
                  color: 'var(--term-fg)',
                  background: 'var(--term-alt)',
                }}
              >
                {Math.round(zoom * 100)}%
              </span>
              <span
                onClick={onZoomIn}
                style={{
                  padding: '3px 8px',
                  borderLeft: '1px solid var(--term-line)',
                  color: 'var(--term-mid)',
                  cursor: 'pointer',
                }}
              >
                +
              </span>
            </div>
            <span
              onClick={onFit}
              style={{ cursor: 'pointer', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              title="fit map to the visible area"
            >
              <Tag color={zoomMode === 'auto' ? 'var(--term-accent)' : 'var(--term-mid)'}>
                fit
              </Tag>
            </span>
            <div style={{ width: 1, height: 16, background: 'var(--term-line)' }} />
          </>
        )}
        <div
          role="tablist"
          aria-label="Map views"
          style={{
            display: 'flex',
            border: '1px solid var(--term-line)',
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        >
          {MAP_VIEWS.map((v, i) => {
            const active = v === view;
            return (
              <span
                key={v}
                role="tab"
                aria-selected={active}
                onClick={() => setView(v)}
                style={{
                  padding: '3px 10px',
                  color: active ? 'var(--term-fg)' : 'var(--term-mid)',
                  background: active ? 'var(--term-alt)' : 'var(--term-surface)',
                  borderRight: i < MAP_VIEWS.length - 1 ? '1px solid var(--term-line)' : 'none',
                  cursor: active ? 'default' : 'pointer',
                  fontWeight: active ? 700 : 450,
                }}
              >
                {MAP_VIEW_LABELS[v]}
              </span>
            );
          })}
        </div>
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
        background: 'var(--term-bg)',
        backgroundImage: 'radial-gradient(var(--term-line) 1px, transparent 1px)',
        backgroundSize: '16px 16px',
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
