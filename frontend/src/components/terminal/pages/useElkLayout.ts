/**
 * ELK.js-based layout engine for the Map page.
 *
 * Replaces dagre with Eclipse Layout Kernel (ELK) which provides:
 * - Built-in edge routing (orthogonal / polyline / spline)
 * - Better crossing minimization
 * - Edge-node obstacle avoidance
 *
 * The hook returns the same shape as the dagre `layout` memo so Map.tsx can
 * swap between engines via a single boolean toggle.
 */
import { useState, useEffect, useRef } from 'react';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api';
import type { ProjectEdge, Tree } from '../../../state/chatTypes';

// Singleton ELK instance — no need to create one per render.
const elk = new ELK();

export type ElkLayoutResult = {
  ids: string[];
  positions: Map<string, { x: number; y: number }>;
  /** Edge bend-points computed by ELK for proper routing. */
  edgeRoutes: Map<string, { sections: ElkEdgeSection[] }>;
  width: number;
  height: number;
} | null;

export type ElkEdgeSection = {
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  bendPoints?: { x: number; y: number }[];
};

const CARD_W = 348;
const CARD_H = 118;
const CARD_H_EXPANDED = 220;
const NODE_SEP = 100;
const RANK_SEP = 160;
const PAD = 36;

export type ElkRoutingStyle = 'SPLINES' | 'POLYLINE' | 'ORTHOGONAL';

interface UseElkLayoutParams {
  enabled: boolean;
  trees: readonly Tree[];
  activeTree: Tree | null;
  edges: readonly ProjectEdge[];
  liveSet: Set<string>;
  mode: string; // 'thread' | 'graph' | 'overview'
  expandedSet: Set<string>;
  measuredHeights: Map<string, number>;
  graphChildren: Map<string, string[]>;
  routingStyle?: ElkRoutingStyle;
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

export function useElkLayout({
  enabled,
  trees,
  activeTree,
  edges,
  liveSet,
  mode,
  expandedSet,
  measuredHeights,
  graphChildren,
  routingStyle = 'SPLINES',
}: UseElkLayoutParams): ElkLayoutResult {
  const [result, setResult] = useState<ElkLayoutResult>(null);
  // Generation counter to discard stale async results.
  const genRef = useRef(0);

  useEffect(() => {
    if (!enabled || mode === 'overview') {
      setResult(null);
      return;
    }

    const graphTrees =
      mode === 'thread'
        ? activeTree
          ? [activeTree]
          : []
        : [...trees]
            .filter((t) => !t.archivedAt && liveSet.has(t.rootNodeId))
            .sort((a, b) => a.createdAt - b.createdAt);

    if (graphTrees.length === 0) {
      setResult({
        ids: [],
        positions: new Map(),
        edgeRoutes: new Map(),
        width: CARD_W + PAD * 2,
        height: CARD_H + PAD * 2,
      });
      return;
    }

    // Build a flat ELK graph with all visible nodes and edges.
    // ELK's layered algorithm handles the full graph at once, including
    // cross-tree merge edges, and routes edges around nodes.
    const allIds: string[] = [];
    const idSet = new Set<string>();

    for (const tree of graphTrees) {
      const ids = collectReachableIds(tree.rootNodeId, graphChildren, liveSet);
      for (const id of ids) {
        if (!idSet.has(id)) {
          idSet.add(id);
          allIds.push(id);
        }
      }
    }

    const elkNodes: ElkNode[] = allIds.map((id) => {
      const h = expandedSet.has(id)
        ? Math.max(CARD_H_EXPANDED, measuredHeights.get(id) ?? CARD_H_EXPANDED)
        : CARD_H;
      return { id, width: CARD_W, height: h };
    });

    const elkEdges: ElkExtendedEdge[] = [];
    for (const e of edges) {
      if (e.kind && e.kind !== 'branch' && e.kind !== 'merge') continue;
      if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
      elkEdges.push({
        id: `${e.source}->${e.target}`,
        sources: [e.source],
        targets: [e.target],
      });
    }

    const graph: ElkNode = {
      id: 'root',
      children: elkNodes,
      edges: elkEdges,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.layered.spacing.nodeNodeBetweenLayers': String(RANK_SEP),
        'elk.spacing.nodeNode': String(NODE_SEP),
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.edgeRouting': routingStyle,
        // Edge-node spacing: ensure edges keep generous distance from node boxes.
        'elk.spacing.edgeNode': '30',
        'elk.layered.spacing.edgeEdgeBetweenLayers': '24',
        'elk.layered.spacing.edgeNodeBetweenLayers': '50',
        // Consider model order for deterministic results.
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      },
    };

    const gen = ++genRef.current;

    elk.layout(graph).then((laid) => {
      if (genRef.current !== gen) return; // stale

      const positions = new Map<string, { x: number; y: number }>();
      let maxX = 0;
      let maxY = 0;

      for (const node of laid.children ?? []) {
        // ELK positions are top-left corner. Convert to center for parity with dagre.
        const cx = PAD + (node.x ?? 0) + (node.width ?? CARD_W) / 2;
        const cy = PAD + (node.y ?? 0) + (node.height ?? CARD_H) / 2;
        positions.set(node.id, { x: cx, y: cy });
        const right = cx + CARD_W / 2;
        const bottom = cy + CARD_H / 2;
        if (right > maxX) maxX = right;
        if (bottom > maxY) maxY = bottom;
      }

      // Edge routes (ELK returns sections with bendPoints).
      const edgeRoutes = new Map<string, { sections: ElkEdgeSection[] }>();
      for (const edge of laid.edges ?? []) {
        if (edge.sections && edge.sections.length > 0) {
          edgeRoutes.set(edge.id, {
            sections: edge.sections.map((s) => ({
              startPoint: s.startPoint,
              endPoint: s.endPoint,
              bendPoints: s.bendPoints,
            })),
          });
        }
      }

      setResult({
        ids: allIds,
        positions,
        edgeRoutes,
        width: maxX + PAD,
        height: maxY + PAD,
      });
    }).catch((err) => {
      console.error('[ELK layout error]', err);
      setResult(null);
    });
  }, [enabled, trees, activeTree, edges, liveSet, mode, expandedSet, measuredHeights, graphChildren, routingStyle]);

  return result;
}

/**
 * Render an SVG path `d` from ELK edge sections.
 * Returns a smooth path for splines, or a polyline for orthogonal/polyline routing.
 */
export function elkEdgePathD(
  sections: ElkEdgeSection[],
  sourcePos: { x: number; y: number },
  targetPos: { x: number; y: number },
  routingStyle: ElkRoutingStyle,
): string {
  if (sections.length === 0) {
    // Fallback: simple bezier between card edges (same as dagre default).
    const sx = sourcePos.x + CARD_W / 2;
    const sy = sourcePos.y;
    const tx = targetPos.x - CARD_W / 2;
    const ty = targetPos.y;
    const dx = Math.max(42, (tx - sx) * 0.5);
    return `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
  }

  const parts: string[] = [];
  for (const section of sections) {
    const { startPoint, endPoint, bendPoints } = section;
    const sx = startPoint.x + PAD;
    const sy = startPoint.y + PAD;
    parts.push(`M${sx},${sy}`);

    if (!bendPoints || bendPoints.length === 0) {
      // No bends: smooth bezier between start and end.
      const ex = endPoint.x + PAD;
      const ey = endPoint.y + PAD;
      const dx = Math.max(30, Math.abs(ex - sx) * 0.4);
      parts.push(`C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}`);
    } else if (routingStyle === 'SPLINES') {
      // Smooth curve through bend points.
      // Build point list: start → bends → end, then use smooth cubic segments.
      const pts = [
        { x: sx, y: sy },
        ...bendPoints.map((bp) => ({ x: bp.x + PAD, y: bp.y + PAD })),
        { x: endPoint.x + PAD, y: endPoint.y + PAD },
      ];

      // For 2 points (just start→end) this is a line.
      // For 3+ points, use cubic bezier with computed control points.
      if (pts.length === 2) {
        parts.push(`L${pts[1].x},${pts[1].y}`);
      } else {
        // Catmull-Rom-style smooth: for each segment, compute tangent-aligned control points.
        for (let i = 1; i < pts.length; i++) {
          const prev = pts[i - 1];
          const curr = pts[i];
          const next = pts[Math.min(i + 1, pts.length - 1)];
          const prevPrev = pts[Math.max(0, i - 2)];

          // Control point 1: continuation of previous direction.
          const cp1x = prev.x + (curr.x - prevPrev.x) / 6;
          const cp1y = prev.y + (curr.y - prevPrev.y) / 6;
          // Control point 2: anticipation of next direction.
          const cp2x = curr.x - (next.x - prev.x) / 6;
          const cp2y = curr.y - (next.y - prev.y) / 6;

          parts.push(`C${cp1x},${cp1y} ${cp2x},${cp2y} ${curr.x},${curr.y}`);
        }
      }
    } else {
      // Polyline / orthogonal: straight segments through each bend point.
      for (const bp of bendPoints) {
        parts.push(`L${bp.x + PAD},${bp.y + PAD}`);
      }
      parts.push(`L${endPoint.x + PAD},${endPoint.y + PAD}`);
    }
  }

  return parts.join(' ');
}
