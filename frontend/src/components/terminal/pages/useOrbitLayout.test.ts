import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ProjectEdge, Tree } from '../../../state/chatTypes';
import { useOrbitLayout, type OrbitVariant } from './useOrbitLayout';

const CARD_W = 348;
const CARD_H = 118;
const CARD_H_EXPANDED = 220;

/**
 * Build the tree shape from the "Gamma 东京部署失败根因" screenshot: a root
 * with many first-level branches, several of which continue as 1–2 deep chains.
 */
function buildTree(): { edges: ProjectEdge[]; children: Map<string, string[]>; ids: string[] } {
  const edges: ProjectEdge[] = [];
  const add = (source: string, target: string) => edges.push({ source, target });

  const branches = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'];
  for (const b of branches) add('root', b);
  add('b4', 'b4a');
  add('b5', 'b5a');
  add('b5', 'b5b');
  add('b5a', 'b5a1');
  add('b7', 'b7a');
  add('b7a', 'b7a1');
  add('b7a1', 'b7a2');
  add('b8', 'b8a');
  add('b8', 'b8b');
  add('b8', 'b8c');

  const children = new Map<string, string[]>();
  for (const e of edges) {
    children.set(e.source, [...(children.get(e.source) ?? []), e.target]);
  }
  const ids = Array.from(new Set(edges.flatMap((e) => [e.source, e.target])));
  return { edges, children, ids };
}

function assertNoOverlap(
  positions: Map<string, { x: number; y: number }>,
  expanded: Set<string>,
) {
  const entries = Array.from(positions.entries());
  const h = (id: string) => (expanded.has(id) ? CARD_H_EXPANDED : CARD_H);
  const collisions: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [a, pa] = entries[i];
      const [b, pb] = entries[j];
      const dx = Math.abs(pa.x - pb.x);
      const dy = Math.abs(pa.y - pb.y);
      if (dx < CARD_W && dy < (h(a) + h(b)) / 2) {
        collisions.push(`${a}↔${b} (dx=${dx.toFixed(0)}, dy=${dy.toFixed(0)})`);
      }
    }
  }
  expect(collisions, 'overlapping cards').toEqual([]);
}

const variants: OrbitVariant[] = ['orbit-full', 'orbit-semi', 'orbit-right'];

describe('useOrbitLayout', () => {
  const tree: Tree = { id: 't1', rootNodeId: 'root', createdAt: 0, lastActiveAt: 0 };

  for (const variant of variants) {
    it(`${variant}: places every node without overlapping cards`, () => {
      const { edges, children, ids } = buildTree();
      const liveSet = new Set(ids);
      // Keep effect dependencies stable across the hook's own state updates.
      const initialProps = {
        enabled: true,
        trees: [tree],
        activeTree: tree,
        edges,
        liveSet,
        mode: 'thread',
        expandedSet: new Set<string>(),
        measuredHeights: new Map<string, number>(),
        graphChildren: children,
        variant,
      };
      const { result, rerender } = renderHook(useOrbitLayout, { initialProps });

      const layout = result.current;
      rerender(initialProps);
      expect(result.current).toBe(layout);
      expect(layout).not.toBeNull();
      expect(layout!.ids).toHaveLength(ids.length);
      for (const id of ids) expect(layout!.positions.has(id)).toBe(true);
      assertNoOverlap(layout!.positions, new Set());

      // Every card lies inside the reported canvas.
      for (const pos of layout!.positions.values()) {
        expect(pos.x - CARD_W / 2).toBeGreaterThanOrEqual(0);
        expect(pos.y - CARD_H / 2).toBeGreaterThanOrEqual(0);
        expect(pos.x + CARD_W / 2).toBeLessThanOrEqual(layout!.width);
        expect(pos.y + CARD_H / 2).toBeLessThanOrEqual(layout!.height);
      }
    });

    it(`${variant}: keeps expanded cards clear of their neighbours`, () => {
      const { edges, children, ids } = buildTree();
      const liveSet = new Set(ids);
      const expandedSet = new Set(['root', 'b5', 'b7a1']);
      const { result } = renderHook(useOrbitLayout, {
        initialProps: {
          enabled: true,
          trees: [tree],
          activeTree: tree,
          edges,
          liveSet,
          mode: 'thread',
          expandedSet,
          measuredHeights: new Map<string, number>(),
          graphChildren: children,
          variant,
        },
      });
      assertNoOverlap(result.current!.positions, expandedSet);
    });
  }

  it('routes every branch edge between positioned cards', () => {
    const { edges, children, ids } = buildTree();
    const { result } = renderHook(useOrbitLayout, {
      initialProps: {
        enabled: true,
        trees: [tree],
        activeTree: tree,
        edges,
        liveSet: new Set(ids),
        mode: 'thread',
        expandedSet: new Set<string>(),
        measuredHeights: new Map<string, number>(),
        graphChildren: children,
        variant: 'orbit-semi' as OrbitVariant,
      },
    });
    const routes = result.current!.edgeRoutes!;
    for (const e of edges) {
      expect(routes.has(`${e.source}->${e.target}`)).toBe(true);
    }
  });
});
