import { describe, expect, it } from 'vitest';
import type { PageDto } from 'michi-shared';
import type { MichiPageEditOp } from '../content/page/editorTypes';
import { contentOnly, toMichiBlock, toNativePageOps } from './nativeBlockAdapter';

const page: PageDto = {
  id: 'pg-1', workspaceId: 'ws-1', parentId: null, position: 0, title: 'Plan', color: null,
  updatedAt: 10, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 7,
  viewVersion: 8,
  blocks: [
    { id: 'blk-md', rev: 3, type: 'markdown', text: 'Original', edit: { at: 5 }, sources: [{ nodeId: 'node-1', turnId: 'turn-1', assistantId: 'msg-1' }] },
    { id: 'blk-check', rev: 2, type: 'checklist', title: 'Next', items: [{ text: 'Ship', done: false }] },
  ],
};

describe('native block adapter', () => {
  it('keeps the renderer projection separate from native concurrency and provenance metadata', () => {
    const display = toMichiBlock(page.blocks[0]);
    expect(display).toMatchObject({ id: 'blk-md', type: 'markdown', text: 'Original', edit: { at: 5 } });
    expect(display).not.toHaveProperty('rev');
    expect(display).not.toHaveProperty('sources');
    expect(page.blocks[0].rev).toBe(3);
    expect(page.blocks[0].sources?.[0].nodeId).toBe('node-1');
  });

  it('converts only strict same-type content edits and includes the observed block revision', () => {
    const ops: MichiPageEditOp[] = [
      { op: 'update', id: 'blk-md', block: { id: 'blk-md', type: 'markdown', text: 'Revised', edit: { at: 5 }, rev: 3 } },
      { op: 'release', id: 'blk-md' },
    ];
    expect(toNativePageOps(ops, page)).toEqual([
      { op: 'update', id: 'blk-md', block: { type: 'markdown', text: 'Revised' }, expectRev: 3 },
      { op: 'release', id: 'blk-md', expectRev: 3 },
    ]);
  });

  it('converts inserts, deletes and moves to the native operation vocabulary', () => {
    expect(toNativePageOps([
      { op: 'insert', after: 'blk-md', block: { type: 'markdown', text: 'New note' } },
      { op: 'move', id: 'blk-check', after: 'blk-md' },
      { op: 'delete', id: 'blk-check' },
    ], page)).toEqual([
      { op: 'insert', block: { type: 'markdown', text: 'New note' }, after: 'blk-md' },
      { op: 'move', id: 'blk-check', after: 'blk-md', expectRev: 2 },
      { op: 'delete', id: 'blk-check', expectRev: 2 },
    ]);
  });

  it('rejects type changes, unknown IDs and invalid native content', () => {
    expect(toNativePageOps([{ op: 'update', id: 'blk-md', block: { id: 'blk-md', type: 'callout', text: 'Changed' } }], page)).toBeNull();
    expect(toNativePageOps([{ op: 'insert', after: null, block: { type: 'heading', text: 'Heading' } }], page)).toEqual([
      { op: 'insert', block: { type: 'heading', text: 'Heading' }, after: null },
    ]);
    expect(toNativePageOps([{ op: 'delete', id: 'missing' }], page)).toBeNull();
    expect(toNativePageOps([{ op: 'update', id: 'blk-md', block: { id: 'blk-md', type: 'markdown', text: 42 } }], page)).toBeNull();
  });

  it('keeps grid child identities stable across region moves and strips only renderer metadata', () => {
    const grid = { id: 'grid', rev: 1, type: 'grid' as const, regions: [
      { id: 'one.0/α', span: 8, blocks: [{ type: 'markdown' as const, text: 'Main' }] },
      { id: 'two', span: 4, blocks: [{ type: 'markdown' as const, text: 'Aside' }] },
    ] };
    const original = toMichiBlock(grid);
    const moved = toMichiBlock({ ...grid, regions: [...grid.regions].reverse() });
    const first = (original.regions as Array<{ id: string; blocks: Array<{ id: string }> }>)[0];
    const last = (moved.regions as Array<{ id: string; blocks: Array<{ id: string }> }>)[1];
    expect(last.blocks[0].id).toBe(first.blocks[0].id);
    expect(contentOnly(moved)).toEqual({ type: 'grid', regions: [...grid.regions].reverse() });
  });
});
