/**
 * Orbit layout engine for the Map page.
 *
 * Three modes:
 *   - 'orbit-full'  — 360° ring around Root (best for ≈square nodes or 20+ leaves)
 *   - 'orbit-semi'  — Left/Right dual-fan (best for wide cards, ≤12 branches per side)
 *   - 'orbit-right' — Single right-side fan (best for moderate fan-out, preserves reading direction)
 *
 * All three share a polar-coordinate core: root at center, children radiate
 * outward. Subtrees grow along their parent's sector without crossing into
 * sibling sectors.
 *
 * Returns the same ElkLayoutResult shape so Map.tsx can consume it identically
 * to the ELK/dagre engines.
 */
import { useState, useEffect, useRef } from 'react';
import type { ProjectEdge, Tree } from '../../../state/chatTypes';
import type { ElkLayoutResult, ElkEdgeSection } from './useElkLayout';

// ─── Constants ─────────────────────────────────────────────────────────────

const CARD_W = 348;
const CARD_H = 118;
const CARD_H_EXPANDED = 220;
const GAP = 28;               // min gap between card edges
const RING_GAP = 160;         // radial gap between depth rings
const MIN_RADIUS = 300;       // minimum first-ring radius
const PAD = 60;               // canvas padding
const MAX_PER_RING = 10;      // force a new ring after this many nodes
const MIN_SECTOR_ANGLE = Math.PI / 12; // 15° minimum per branch

// ─── Types ─────────────────────────────────────────────────────────────────

export type OrbitVariant = 'orbit-full' | 'orbit-semi' | 'orbit-right';

export interface UseOrbitLayoutParams {
  enabled: boolean;
  trees: readonly Tree[];
  activeTree: Tree | null;
  edges: readonly ProjectEdge[];
  liveSet: Set<string>;
  mode: string;
  expandedSet: Set<string>;
  measuredHeights: Map<string, number>;
  graphChildren: Map<string, string[]>;
  variant: OrbitVariant;
}

// ─── Subtree weight (recursive, memoized per call) ─────────────────────────

function computeSubtreeWeights(
  rootId: string,
  childMap: Map<string, string[]>,
  liveSet: Set<string>,
  cache: Map<string, number>,
): number {
  if (cache.has(rootId)) return cache.get(rootId)!;
  const kids = (childMap.get(rootId) ?? []).filter(id => liveSet.has(id));
  let w = 1;
  for (const kid of kids) {
    w += computeSubtreeWeights(kid, childMap, liveSet, cache);
  }
  cache.set(rootId, w);
  return w;
}

// ─── Collect reachable ids (BFS, branch edges only) ────────────────────────

function collectReachable(
  rootId: string,
  childMap: Map<string, string[]>,
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
    for (const c of childMap.get(id) ?? []) queue.push(c);
  }
  return ids;
}

// ─── Core layout algorithm ─────────────────────────────────────────────────

interface PositionResult {
  positions: Map<string, { x: number; y: number }>;
  ids: string[];
  width: number;
  height: number;
}

/**
 * Returns the angle range [startAngle, endAngle] depending on variant.
 */
function variantAngleRange(variant: OrbitVariant): { start: number; end: number } {
  switch (variant) {
    case 'orbit-full':
      // Full 360° circle. Start at top (-π/2), sweep full circle.
      return { start: -Math.PI, end: Math.PI };
    case 'orbit-semi':
      // Dual fan: left fan [-150°, -30°] and right fan [30°, 150°]
      // We'll handle this specially in the layout function.
      return { start: -Math.PI, end: Math.PI };
    case 'orbit-right':
      // Right-side single fan: -75° to +75° (150° arc on the right)
      return { start: -5 * Math.PI / 12, end: 5 * Math.PI / 12 };
  }
}

function computeOrbitLayout(
  rootId: string,
  childMap: Map<string, string[]>,
  liveSet: Set<string>,
  expandedSet: Set<string>,
  measuredHeights: Map<string, number>,
  variant: OrbitVariant,
): PositionResult {
  const ids = collectReachable(rootId, childMap, liveSet);
  const positions = new Map<string, { x: number; y: number }>();

  if (ids.length === 0) {
    return { positions, ids, width: CARD_W + PAD * 2, height: CARD_H + PAD * 2 };
  }

  // Weight cache
  const weightCache = new Map<string, number>();
  for (const id of ids) {
    computeSubtreeWeights(id, childMap, liveSet, weightCache);
  }

  // Root at origin (we'll shift everything to positive coords at the end)
  positions.set(rootId, { x: 0, y: 0 });

  const level1 = (childMap.get(rootId) ?? []).filter(id => liveSet.has(id));

  if (level1.length === 0) {
    // Root only
    return {
      positions: new Map([[rootId, { x: PAD + CARD_W / 2, y: PAD + CARD_H / 2 }]]),
      ids,
      width: CARD_W + PAD * 2,
      height: CARD_H + PAD * 2,
    };
  }

  // ─── Compute card height helper ──────────────────────────────────────
  const cardH = (id: string) =>
    expandedSet.has(id)
      ? Math.max(CARD_H_EXPANDED, measuredHeights.get(id) ?? CARD_H_EXPANDED)
      : CARD_H;

  // ─── Determine sectors ───────────────────────────────────────────────

  if (variant === 'orbit-semi') {
    // Dual-fan: split branches alternately into left and right sides.
    // Sort by weight descending, alternate assignment for balance.
    const weighted = level1.map(id => ({ id, w: weightCache.get(id) ?? 1 }));
    weighted.sort((a, b) => b.w - a.w);

    const leftBranches: string[] = [];
    const rightBranches: string[] = [];
    let leftWeight = 0;
    let rightWeight = 0;

    for (const { id, w } of weighted) {
      // Assign to the lighter side for balance
      if (leftWeight <= rightWeight) {
        leftBranches.push(id);
        leftWeight += w;
      } else {
        rightBranches.push(id);
        rightWeight += w;
      }
    }

    // Layout each side as a fan
    layoutFan(rootId, rightBranches, -Math.PI / 3, Math.PI / 3, 1, childMap, liveSet, expandedSet, measuredHeights, weightCache, positions, cardH);
    layoutFan(rootId, leftBranches, 2 * Math.PI / 3, 4 * Math.PI / 3, 1, childMap, liveSet, expandedSet, measuredHeights, weightCache, positions, cardH);
  } else {
    // Full ring or right-fan
    const { start, end } = variantAngleRange(variant);
    layoutFan(rootId, level1, start, end, 1, childMap, liveSet, expandedSet, measuredHeights, weightCache, positions, cardH);
  }

  // ─── Normalize to positive coordinates ───────────────────────────────
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pos of positions.values()) {
    minX = Math.min(minX, pos.x - CARD_W / 2);
    minY = Math.min(minY, pos.y - CARD_H / 2);
    maxX = Math.max(maxX, pos.x + CARD_W / 2);
    maxY = Math.max(maxY, pos.y + CARD_H / 2);
  }

  const offsetX = -minX + PAD;
  const offsetY = -minY + PAD;
  const normalized = new Map<string, { x: number; y: number }>();
  for (const [id, pos] of positions) {
    normalized.set(id, { x: pos.x + offsetX, y: pos.y + offsetY });
  }

  return {
    positions: normalized,
    ids,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
  };
}

// ─── Fan layout (shared by all variants) ───────────────────────────────────

function layoutFan(
  _parentId: string,
  branches: string[],
  startAngle: number,
  endAngle: number,
  depth: number,
  childMap: Map<string, string[]>,
  liveSet: Set<string>,
  expandedSet: Set<string>,
  measuredHeights: Map<string, number>,
  weightCache: Map<string, number>,
  positions: Map<string, { x: number; y: number }>,
  cardH: (id: string) => number,
): void {
  if (branches.length === 0) return;

  const totalAngle = endAngle - startAngle;
  const radius = MIN_RADIUS + (depth - 1) * RING_GAP;

  // Compute minimum angle needed for collision avoidance at this radius
  const minAngleForCard = 2 * Math.asin(
    Math.min(1, (CARD_H + GAP) / (2 * radius))
  );
  const effectiveMinAngle = Math.max(MIN_SECTOR_ANGLE, minAngleForCard);

  // Assign angle spans based on subtree weights
  const totalWeight = branches.reduce((s, id) => s + Math.sqrt(weightCache.get(id) ?? 1), 0);

  // Check if we need multiple rings at this depth
  const totalNeededAngle = branches.length * effectiveMinAngle;
  let rings: string[][] = [branches];

  if (totalNeededAngle > Math.abs(totalAngle)) {
    // Split into rings
    rings = [];
    let currentRing: string[] = [];
    let usedAngle = 0;
    for (const id of branches) {
      if (usedAngle + effectiveMinAngle > Math.abs(totalAngle) && currentRing.length > 0) {
        rings.push(currentRing);
        currentRing = [];
        usedAngle = 0;
      }
      currentRing.push(id);
      usedAngle += effectiveMinAngle;
    }
    if (currentRing.length > 0) rings.push(currentRing);
  }

  for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
    const ringBranches = rings[ringIdx];
    const ringRadius = radius + ringIdx * (CARD_H + GAP + 40);

    // Weighted angle allocation within this ring
    const ringTotalWeight = ringBranches.reduce(
      (s, id) => s + Math.sqrt(weightCache.get(id) ?? 1), 0
    );

    let cursor = startAngle;
    for (let i = 0; i < ringBranches.length; i++) {
      const id = ringBranches[i];
      const w = Math.sqrt(weightCache.get(id) ?? 1);
      const rawSpan = (w / ringTotalWeight) * totalAngle;
      const span = Math.max(rawSpan, effectiveMinAngle);
      const θ = cursor + span / 2;

      const x = ringRadius * Math.cos(θ);
      const y = ringRadius * Math.sin(θ);
      positions.set(id, { x, y });

      // Recurse into children of this branch
      const kids = (childMap.get(id) ?? []).filter(cid => liveSet.has(cid));
      if (kids.length > 0) {
        const sectorStart = cursor;
        const sectorEnd = cursor + span;

        // If sector is too narrow for children, switch to radial-flow
        if (Math.abs(sectorEnd - sectorStart) < MIN_SECTOR_ANGLE * 1.5 || kids.length === 1) {
          // Radial flow: place children in a line extending outward from parent
          layoutRadialFlow(id, kids, θ, depth + 1, childMap, liveSet, expandedSet, measuredHeights, weightCache, positions, cardH);
        } else {
          layoutFan(id, kids, sectorStart, sectorEnd, depth + 1, childMap, liveSet, expandedSet, measuredHeights, weightCache, positions, cardH);
        }
      }

      cursor += span;
    }
  }
}

// ─── Radial flow: linear chain extending outward from parent ───────────────

function layoutRadialFlow(
  parentId: string,
  children: string[],
  angle: number,
  depth: number,
  childMap: Map<string, string[]>,
  liveSet: Set<string>,
  expandedSet: Set<string>,
  measuredHeights: Map<string, number>,
  weightCache: Map<string, number>,
  positions: Map<string, { x: number; y: number }>,
  cardH: (id: string) => number,
): void {
  const parentPos = positions.get(parentId);
  if (!parentPos) return;

  const step = RING_GAP * 0.8;

  for (let i = 0; i < children.length; i++) {
    const id = children[i];
    const dist = step * (i + 1);

    // Spread children slightly in the perpendicular direction if multiple
    const perpOffset = children.length > 1
      ? (i - (children.length - 1) / 2) * (CARD_H + GAP) * 0.6
      : 0;

    const x = parentPos.x + dist * Math.cos(angle) + perpOffset * Math.cos(angle + Math.PI / 2);
    const y = parentPos.y + dist * Math.sin(angle) + perpOffset * Math.sin(angle + Math.PI / 2);
    positions.set(id, { x, y });

    // Recurse
    const kids = (childMap.get(id) ?? []).filter(cid => liveSet.has(cid));
    if (kids.length > 0) {
      layoutRadialFlow(id, kids, angle, depth + 1, childMap, liveSet, expandedSet, measuredHeights, weightCache, positions, cardH);
    }
  }
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useOrbitLayout({
  enabled,
  trees,
  activeTree,
  edges,
  liveSet,
  mode,
  expandedSet,
  measuredHeights,
  graphChildren,
  variant,
}: UseOrbitLayoutParams): ElkLayoutResult {
  const [result, setResult] = useState<ElkLayoutResult>(null);
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

    const gen = ++genRef.current;

    // Layout each tree, then composite them side-by-side
    const allIds: string[] = [];
    const allPositions = new Map<string, { x: number; y: number }>();
    const TREE_GAP = 120;
    let offsetX = 0;

    for (const tree of graphTrees) {
      const layoutResult = computeOrbitLayout(
        tree.rootNodeId,
        graphChildren,
        liveSet,
        expandedSet,
        measuredHeights,
        variant,
      );

      for (const id of layoutResult.ids) {
        allIds.push(id);
      }
      for (const [id, pos] of layoutResult.positions) {
        allPositions.set(id, { x: pos.x + offsetX, y: pos.y });
      }
      offsetX += layoutResult.width + TREE_GAP;
    }

    // Compute final bounds
    let maxX = 0, maxY = 0;
    for (const pos of allPositions.values()) {
      const right = pos.x + CARD_W / 2;
      const bottom = pos.y + CARD_H / 2;
      if (right > maxX) maxX = right;
      if (bottom > maxY) maxY = bottom;
    }

    // Edge routes: smooth curves from source card edge to target card edge.
    // Coordinates are in final canvas space (same as positions).
    const edgeRoutes = new Map<string, { sections: ElkEdgeSection[] }>();
    for (const e of edges) {
      if (e.kind && e.kind !== 'branch' && e.kind !== 'merge') continue;
      const srcPos = allPositions.get(e.source);
      const tgtPos = allPositions.get(e.target);
      if (!srcPos || !tgtPos) continue;

      const edgeKey = `${e.source}->${e.target}`;
      const dx = tgtPos.x - srcPos.x;
      const dy = tgtPos.y - srcPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue; // skip zero-length edges

      // Edge exits from the source card border toward target
      const angle = Math.atan2(dy, dx);
      // Use elliptical intersection for a rectangle approximation
      const srcExitX = srcPos.x + (CARD_W / 2) * Math.cos(angle);
      const srcExitY = srcPos.y + (CARD_H / 2) * Math.sin(angle);
      const tgtEntryX = tgtPos.x - (CARD_W / 2) * Math.cos(angle);
      const tgtEntryY = tgtPos.y - (CARD_H / 2) * Math.sin(angle);

      // Bend point: slight perpendicular offset at midpoint for curvature
      const curvature = e.kind === 'merge' ? 0.25 : 0.08;
      const mx = (srcExitX + tgtEntryX) / 2 + dy * curvature;
      const my = (srcExitY + tgtEntryY) / 2 - dx * curvature;

      edgeRoutes.set(edgeKey, {
        sections: [{
          startPoint: { x: srcExitX, y: srcExitY },
          endPoint: { x: tgtEntryX, y: tgtEntryY },
          bendPoints: [{ x: mx, y: my }],
        }],
      });
    }

    if (genRef.current !== gen) return; // stale

    setResult({
      ids: allIds,
      positions: allPositions,
      edgeRoutes,
      width: maxX + PAD,
      height: maxY + PAD,
    });
  }, [enabled, trees, activeTree, edges, liveSet, mode, expandedSet, measuredHeights, graphChildren, variant]);

  return result;
}

// ─── Auto-select variant based on graph shape ──────────────────────────────

export function autoSelectVariant(
  rootId: string,
  childMap: Map<string, string[]>,
  liveSet: Set<string>,
): OrbitVariant {
  const level1 = (childMap.get(rootId) ?? []).filter(id => liveSet.has(id));
  const count = level1.length;

  if (count <= 5) return 'orbit-right';   // few branches → right fan is clean
  if (count <= 12) return 'orbit-semi';   // moderate → dual fan for balance
  return 'orbit-full';                     // many → full ring
}
