/**
 * Orbit layout engine for the Map page — elliptical-coordinate rewrite.
 *
 * Three modes:
 *   - 'orbit-full'  — 360° ring around Root
 *   - 'orbit-semi'  — Left/Right dual-fan with greedy weight-balanced sides
 *   - 'orbit-right' — Single right-side fan (preserves reading direction)
 *
 * ## Design: direct elliptical coordinates
 *
 * Cards are wide (348 × 118). The old layout worked in a "normalized square"
 * space and stretched X at the end, but that made collision detection and arc
 * spacing incorrect after stretching.
 *
 * This rewrite places nodes directly in real pixel coordinates from the start.
 * Rings are *ellipses* with semi-axes (rx, ry) where rx > ry to account for
 * card width. At any angle θ the ellipse radius is:
 *
 *     r(θ) = rx·ry / √((ry·cosθ)² + (rx·sinθ)²)
 *
 * The minimum angular separation between two neighbours on a ring is computed
 * from the actual card footprint at that angle, so horizontal neighbours get
 * wider spacing and vertical neighbours get taller spacing — no post-hoc
 * stretch needed.
 *
 * Relaxation is a lightweight 8-iteration pass with correct AABB collision in
 * real pixel space, capped to prevent main-thread freezing.
 */
import { useState, useEffect, useRef } from 'react';
import type { ProjectEdge, Tree } from '../../../state/chatTypes';
import type { ElkLayoutResult, ElkEdgeSection } from './useElkLayout';

// ─── Constants ─────────────────────────────────────────────────────────────

const CARD_W = 348;
const CARD_H = 118;
const CARD_H_EXPANDED = 220;
const GAP = 32;                        // min gap between card edges (px)
const PAD = 60;                        // canvas padding

// Ellipse semi-axes for the first ring.
// rx is wider because cards are wide; ry is taller because cards are short.
// The ratio matches CARD_W/CARD_H so the visual density is uniform.
const BASE_RX = 320;
const BASE_RY = 200;
const RING_STEP_RX = 260;             // radial step per additional ring (x)
const RING_STEP_RY = 170;             // radial step per additional ring (y)

const MIN_SECTOR_ANGLE = Math.PI / 12; // 15° minimum per branch
const MAX_RELAX_ITERS = 8;            // lightweight collision pass

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

type Pos = { x: number; y: number };

interface LayoutCtx {
  childMap: Map<string, string[]>;
  liveSet: Set<string>;
  weightCache: Map<string, number>;
  positions: Map<string, Pos>;
  cardH: (id: string) => number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Subtree weight (recursive, memoized per layout call). */
function subtreeWeight(
  id: string,
  childMap: Map<string, string[]>,
  liveSet: Set<string>,
  cache: Map<string, number>,
): number {
  if (cache.has(id)) return cache.get(id)!;
  const kids = (childMap.get(id) ?? []).filter(cid => liveSet.has(cid));
  let w = 1;
  for (const kid of kids) w += subtreeWeight(kid, childMap, liveSet, cache);
  cache.set(id, w);
  return w;
}

/** BFS to collect all reachable node ids. */
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

function liveKids(id: string, ctx: LayoutCtx): string[] {
  return (ctx.childMap.get(id) ?? []).filter(cid => ctx.liveSet.has(cid));
}

// ─── Ellipse geometry ──────────────────────────────────────────────────────

/** Position on an ellipse with semi-axes (rx, ry) at angle θ. */
function ellipsePoint(rx: number, ry: number, θ: number): Pos {
  return { x: rx * Math.cos(θ), y: ry * Math.sin(θ) };
}

/**
 * Minimum angular separation so two cards on the given elliptical ring
 * at the given angle don't overlap.
 *
 * At angle θ on an ellipse (rx, ry), the local curvature radius determines
 * how much arc a card "consumes". We approximate by computing the chord
 * length needed to clear one card's footprint in the tangent direction,
 * then convert to an angle.
 *
 * The card's footprint projected onto the tangent is:
 *   footprint = |CARD_W · sin(θ)| + |cardH · cos(θ)| + GAP
 * (i.e., a rotated bounding box width perpendicular to the radial direction)
 *
 * The ellipse's local "tangential radius" (distance that a unit angle spans):
 *   tRadius ≈ √((rx·sinθ)² + (ry·cosθ)²)
 *
 * So minAngle ≈ footprint / tRadius.
 */
function minAngleForCard(
  rx: number,
  ry: number,
  θ: number,
  cardHeight: number,
): number {
  const absS = Math.abs(Math.sin(θ));
  const absC = Math.abs(Math.cos(θ));
  // Card footprint perpendicular to the radial direction (along the arc)
  const footprint = CARD_W * absS + cardHeight * absC + GAP;
  // Local tangential speed: ‖d/dθ (rx cosθ, ry sinθ)‖ = √((rx sinθ)² + (ry cosθ)²)
  const tRadius = Math.sqrt((rx * Math.sin(θ)) ** 2 + (ry * Math.cos(θ)) ** 2);
  if (tRadius < 1) return MIN_SECTOR_ANGLE;
  return Math.max(MIN_SECTOR_ANGLE, footprint / tRadius);
}

/**
 * Average minimum angular separation for a set of nodes spread across
 * [startAngle, endAngle]. We sample a few points across the sector.
 */
function avgMinAngle(
  rx: number,
  ry: number,
  startAngle: number,
  endAngle: number,
  cardHeight: number,
): number {
  const samples = 5;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const θ = startAngle + ((endAngle - startAngle) * (i + 0.5)) / samples;
    sum += minAngleForCard(rx, ry, θ, cardHeight);
  }
  return sum / samples;
}

// ─── Core layout ───────────────────────────────────────────────────────────

interface PositionResult {
  positions: Map<string, Pos>;
  ids: string[];
  width: number;
  height: number;
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

  if (ids.length === 0) {
    return { positions: new Map(), ids, width: CARD_W + PAD * 2, height: CARD_H + PAD * 2 };
  }

  const weightCache = new Map<string, number>();
  for (const id of ids) subtreeWeight(id, childMap, liveSet, weightCache);

  const cardH = (id: string) =>
    expandedSet.has(id)
      ? Math.max(CARD_H_EXPANDED, measuredHeights.get(id) ?? CARD_H_EXPANDED)
      : CARD_H;

  const ctx: LayoutCtx = {
    childMap,
    liveSet,
    weightCache,
    positions: new Map<string, Pos>([[rootId, { x: 0, y: 0 }]]),
    cardH,
  };

  const level1 = liveKids(rootId, ctx);

  if (level1.length > 0) {
    // First ring must clear the root card.
    const rootClearance = (cardH(rootId) + CARD_H) / 2 + GAP;
    const rx0 = Math.max(BASE_RX, rootClearance * (CARD_W / CARD_H));
    const ry0 = Math.max(BASE_RY, rootClearance);

    if (variant === 'orbit-semi') {
      const weighted = level1.map(id => ({ id, w: weightCache.get(id) ?? 1 }));
      weighted.sort((a, b) => b.w - a.w);

      const leftBranches: string[] = [];
      const rightBranches: string[] = [];
      let leftW = 0, rightW = 0;
      for (const { id, w } of weighted) {
        if (leftW <= rightW) { leftBranches.push(id); leftW += w; }
        else { rightBranches.push(id); rightW += w; }
      }

      layoutFan(rightBranches, -Math.PI / 3, Math.PI / 3, rx0, ry0, 0, ctx);
      layoutFan(leftBranches, 2 * Math.PI / 3, 4 * Math.PI / 3, rx0, ry0, 0, ctx);
    } else if (variant === 'orbit-full') {
      layoutFan(level1, -Math.PI, Math.PI, rx0, ry0, 0, ctx);
    } else {
      // Right-side fan: ±75°
      layoutFan(level1, -5 * Math.PI / 12, 5 * Math.PI / 12, rx0, ry0, 0, ctx);
    }
  }

  // Lightweight collision relaxation in real pixel space.
  relaxOverlaps(ids, ctx);

  // Shift all positions into positive canvas coordinates.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [id, pos] of ctx.positions) {
    const h = cardH(id);
    minX = Math.min(minX, pos.x - CARD_W / 2);
    minY = Math.min(minY, pos.y - h / 2);
    maxX = Math.max(maxX, pos.x + CARD_W / 2);
    maxY = Math.max(maxY, pos.y + h / 2);
  }

  const offsetX = -minX + PAD;
  const offsetY = -minY + PAD;
  const finalPositions = new Map<string, Pos>();
  for (const [id, pos] of ctx.positions) {
    finalPositions.set(id, { x: pos.x + offsetX, y: pos.y + offsetY });
  }

  return {
    positions: finalPositions,
    ids,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
  };
}

// ─── Fan layout (elliptical) ───────────────────────────────────────────────

/**
 * Place `branches` on one or more concentric elliptical rings inside
 * [startAngle, endAngle], then recurse into each branch's subtree using
 * that branch's angular sector.
 *
 * `ringIndex` is the ring depth (0 = first ring); semi-axes grow as:
 *     rx = baseRx + ringIndex * RING_STEP_RX
 *     ry = baseRy + ringIndex * RING_STEP_RY
 */
function layoutFan(
  branches: string[],
  startAngle: number,
  endAngle: number,
  baseRx: number,
  baseRy: number,
  ringIndex: number,
  ctx: LayoutCtx,
): void {
  if (branches.length === 0) return;

  const totalAngle = endAngle - startAngle;
  const rx = baseRx + ringIndex * RING_STEP_RX;
  const ry = baseRy + ringIndex * RING_STEP_RY;

  const maxH = Math.max(...branches.map(ctx.cardH));
  const minA = avgMinAngle(rx, ry, startAngle, endAngle, maxH);

  // Partition into rings if nodes don't fit in a single ring's arc.
  const rings: string[][] = [];
  let ring: string[] = [];
  for (const id of branches) {
    if (ring.length > 0 && (ring.length + 1) * minA > totalAngle) {
      rings.push(ring);
      ring = [];
    }
    ring.push(id);
  }
  if (ring.length > 0) rings.push(ring);

  // Children start beyond the outermost ring of siblings.
  const childRingBase = ringIndex + rings.length;

  rings.forEach((ringBranches, ri) => {
    const curRing = ringIndex + ri;
    const curRx = baseRx + curRing * RING_STEP_RX;
    const curRy = baseRy + curRing * RING_STEP_RY;

    const weights = ringBranches.map(id => Math.sqrt(ctx.weightCache.get(id) ?? 1));
    const totalW = weights.reduce((s, w) => s + w, 0);

    // Each node gets at least minA; the remaining arc is shared by weight.
    const curMinA = avgMinAngle(curRx, curRy, startAngle, endAngle, maxH);
    const slack = Math.max(0, totalAngle - ringBranches.length * curMinA);

    let cursor = startAngle;
    ringBranches.forEach((id, i) => {
      const span = ringBranches.length === 1
        ? totalAngle
        : curMinA + slack * (weights[i] / totalW);
      const θ = cursor + span / 2;

      // Place node on the ellipse at angle θ.
      const pt = ellipsePoint(curRx, curRy, θ);
      ctx.positions.set(id, pt);

      // Recurse into children using this node's angular sector.
      const kids = liveKids(id, ctx);
      if (kids.length > 0) {
        layoutFan(kids, cursor, cursor + span, baseRx, baseRy, childRingBase, ctx);
      }

      cursor += span;
    });
  });
}

// ─── Collision relaxation (real pixel space) ───────────────────────────────

/**
 * Lightweight pass that resolves residual AABB overlaps by pushing nodes
 * outward along their radial direction, carrying the subtree.
 *
 * Now operates in real pixel space with correct CARD_W × cardH collision
 * boxes. Capped at 8 iterations to prevent main-thread freezing.
 */
function relaxOverlaps(ids: string[], ctx: LayoutCtx): void {
  // Pre-compute descendant sets once.
  const descMap = new Map<string, Set<string>>();
  for (const id of ids) {
    if (!descMap.has(id)) {
      descMap.set(id, new Set(collectReachable(id, ctx.childMap, ctx.liveSet)));
    }
  }

  const translateSubtree = (id: string, dx: number, dy: number) => {
    const desc = descMap.get(id);
    if (!desc) return;
    for (const nid of desc) {
      const p = ctx.positions.get(nid);
      if (p) ctx.positions.set(nid, { x: p.x + dx, y: p.y + dy });
    }
  };

  for (let iter = 0; iter < MAX_RELAX_ITERS; iter++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const pa = ctx.positions.get(a);
      if (!pa) continue;
      const ha = ctx.cardH(a);

      for (let j = i + 1; j < ids.length; j++) {
        const b = ids[j];
        const pb = ctx.positions.get(b);
        if (!pb) continue;
        const hb = ctx.cardH(b);

        // AABB overlap test in real pixel space.
        const needX = (CARD_W + GAP) / 2 + CARD_W / 2; // half-widths + gap
        const needY = (ha + hb) / 2 + GAP;
        const dx = Math.abs(pa.x - pb.x);
        const dy = Math.abs(pa.y - pb.y);

        // No overlap if separated on either axis.
        if (dx >= needX || dy >= needY) continue;

        // Decide who to push: descendant, or the one farther from root.
        const descA = descMap.get(a);
        const descB = descMap.get(b);
        let mover: string;
        if (descA?.has(b)) mover = b;
        else if (descB?.has(a)) mover = a;
        else mover = Math.hypot(pa.x, pa.y) >= Math.hypot(pb.x, pb.y) ? a : b;

        const mp = ctx.positions.get(mover)!;
        const dist = Math.hypot(mp.x, mp.y);
        // Push outward along radial direction.
        const ux = dist > 1 ? mp.x / dist : 1;
        const uy = dist > 1 ? mp.y / dist : 0;
        // Push distance: the smaller overlap axis determines the needed push,
        // projected onto the radial direction.
        const overlapX = needX - dx;
        const overlapY = needY - dy;
        const push = Math.max(overlapX, overlapY) + 2;
        translateSubtree(mover, ux * push, uy * push);
        moved = true;
      }
    }
    if (!moved) break;
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

    // Layout each tree, then composite side-by-side.
    const allIds: string[] = [];
    const allPositions = new Map<string, Pos>();
    const TREE_GAP = 120;
    let offsetX = 0;
    let maxHeight = 0;

    for (const tree of graphTrees) {
      const layoutResult = computeOrbitLayout(
        tree.rootNodeId,
        graphChildren,
        liveSet,
        expandedSet,
        measuredHeights,
        variant,
      );

      for (const id of layoutResult.ids) allIds.push(id);
      for (const [id, pos] of layoutResult.positions) {
        allPositions.set(id, { x: pos.x + offsetX, y: pos.y });
      }
      offsetX += layoutResult.width + TREE_GAP;
      maxHeight = Math.max(maxHeight, layoutResult.height);
    }

    // Edge routes: smooth curves in final canvas coordinates.
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
      if (dist < 1) continue;

      // Edge exits from the source card border toward target.
      const angle = Math.atan2(dy, dx);
      const srcExitX = srcPos.x + (CARD_W / 2) * Math.cos(angle);
      const srcExitY = srcPos.y + (CARD_H / 2) * Math.sin(angle);
      const tgtEntryX = tgtPos.x - (CARD_W / 2) * Math.cos(angle);
      const tgtEntryY = tgtPos.y - (CARD_H / 2) * Math.sin(angle);

      // Curvature: slight perpendicular bend at midpoint.
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

    if (genRef.current !== gen) return;

    setResult({
      ids: allIds,
      positions: allPositions,
      edgeRoutes,
      width: Math.max(offsetX - TREE_GAP, CARD_W + PAD * 2),
      height: Math.max(maxHeight, CARD_H + PAD * 2),
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

  if (count <= 5) return 'orbit-right';
  if (count <= 12) return 'orbit-semi';
  return 'orbit-full';
}
