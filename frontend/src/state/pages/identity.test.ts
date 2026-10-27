import { describe, expect, it } from 'vitest';
import { pageSegmentSources, type BlockSource, type PageBlock, type PageBlockInput, type PageChangeDto, type PageDatabase, type PageDto } from 'michi-shared';
import { mapDatabaseIdentity, mapPageBlockIdentity, mapPageBlockInputIdentity, mapPageChangeIdentity, mapPageIdentity } from './identity';

const segmentBlock = (nodeId: string): Extract<PageBlockInput, { type: 'markdown' }> => ({ type: 'markdown', text: '- Cited finding\n- Personal note', segmentSources: [
  { text: '- Cited finding', sources: [{ nodeId, turnId: 'remote:opaque:turn', assistantId: 'remote:opaque:message' }] },
  { text: '- Personal note', sources: [] },
] });

describe('Pages identity mapping', () => {
  it('maps only segment source node identities and retains exact text anchors and uncited entries', () => {
    const block = segmentBlock('node/a');
    const shown = mapPageBlockInputIdentity(block, 'host/one', 'renderer');
    expect(shown).toEqual({ type: 'markdown', text: block.text, segmentSources: [
      { text: '- Cited finding', sources: [{ nodeId: 'remote:host%2Fone:node%2Fa', turnId: 'remote:opaque:turn', assistantId: 'remote:opaque:message' }] },
      { text: '- Personal note', sources: [] },
    ] });
    expect(mapPageBlockInputIdentity(shown, 'host/one', 'server')).toEqual(block);
    expect(block.segmentSources?.[0].sources[0].nodeId).toBe('node/a');
    expect(mapPageBlockInputIdentity(block, 'local', 'renderer')).toEqual(block);
    expect(() => mapPageBlockInputIdentity(shown, 'other-host', 'server')).toThrow('different backend connection');
  });

  it('roundtrips sources through grid, toggle, columns and tabs while preserving opaque region and block ids', () => {
    const content: PageBlockInput = { type: 'grid', regions: [
      { id: 'remote:opaque:region-one', span: 8, tabletSpan: 6, title: 'node/a', blocks: [
        { type: 'toggle', title: 'Details', blocks: [segmentBlock('node/a')] },
      ] },
      { id: 'region-two', span: 4, blocks: [segmentBlock('node-b')] },
    ] };
    const stored: PageBlock = { ...content, id: 'remote:opaque:block', rev: 3, edit: { at: 4 }, sources: pageSegmentSources(content) };
    const shown = mapPageBlockIdentity(stored, 'host/one', 'renderer');
    const expectedSources: BlockSource[] = [
      { nodeId: 'remote:host%2Fone:node%2Fa', turnId: 'remote:opaque:turn', assistantId: 'remote:opaque:message' },
      { nodeId: 'remote:host%2Fone:node-b', turnId: 'remote:opaque:turn', assistantId: 'remote:opaque:message' },
    ];
    expect(pageSegmentSources(shown)).toEqual(expectedSources);
    expect(shown.sources).toEqual(expectedSources);
    expect(shown).toMatchObject({ id: stored.id, rev: 3, edit: { at: 4 }, regions: [
      { id: 'remote:opaque:region-one', span: 8, tabletSpan: 6, title: 'node/a' }, { id: 'region-two', span: 4 },
    ] });
    expect(mapPageBlockIdentity(shown, 'host/one', 'server')).toEqual(stored);
    expect(mapPageBlockInputIdentity(mapPageBlockInputIdentity(content, 'host/one', 'renderer'), 'host/one', 'server')).toEqual(content);

    const tabs: PageBlockInput = { type: 'tabs', tabs: [
      { label: 'First', blocks: [{ type: 'columns', columns: [[segmentBlock('node/a')], [segmentBlock('node-b')]] }] },
      { label: 'Empty', blocks: [] },
    ] };
    const mappedTabs = mapPageBlockInputIdentity(tabs, 'host/one', 'renderer');
    expect(pageSegmentSources(mappedTabs)).toEqual(expectedSources);
    expect(mapPageBlockInputIdentity(mappedTabs, 'host/one', 'server')).toEqual(tabs);
  });

  it('maps the conversations thread cards and conflicts name, both ways', () => {
    const threads = { type: 'threads', title: 'Sessions', nodeIds: ['node-1', 'node-2'] } as const;
    const conflict = { type: 'conflict', question: 'Which day?', options: [{ text: 'Monday', nodeId: 'node-1' }, { text: 'Tuesday', from: 'Kiro' }] } as const;
    const shown = mapPageBlockInputIdentity({ ...threads, nodeIds: [...threads.nodeIds] }, 'host/one', 'renderer');
    expect(shown).toEqual({ ...threads, nodeIds: ['remote:host%2Fone:node-1', 'remote:host%2Fone:node-2'] });
    expect(mapPageBlockInputIdentity(shown, 'host/one', 'server')).toEqual(threads);
    const kept = mapPageBlockInputIdentity({ ...conflict, options: conflict.options.map((option) => ({ ...option })) }, 'host/one', 'renderer');
    expect(kept).toEqual({ ...conflict, options: [{ text: 'Monday', nodeId: 'remote:host%2Fone:node-1' }, { text: 'Tuesday', from: 'Kiro' }] });
    expect(mapPageBlockInputIdentity(kept, 'host/one', 'server')).toEqual(conflict);
  });

  it('maps structural page references while keeping block IDs and prose opaque', () => {
    const page = {
      id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Remote',
      color: null, updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: 'node-1',
      revision: 1, viewVersion: 1,
      blocks: [
        { type: 'database-ref', id: 'block-id', rev: 1, databaseId: 'database-1', viewId: 'view-id', sources: [{ nodeId: 'source-node', turnId: 'turn-id', assistantId: 'assistant-id' }] },
        { type: 'page-link', id: 'link-id', rev: 1, pageId: 'page-2' },
        { type: 'component', id: 'component-block', rev: 1, componentId: 'component-1', props: {} },
        { type: 'markdown', id: 'text-id', rev: 1, text: 'page-1 database-1 node-1' },
      ],
    } as PageDto;

    const mapped = mapPageIdentity(page, 'host/one', 'renderer');
    expect(mapped.id).toBe('remote:host%2Fone:page-1');
    expect(mapped.workspaceId).toBe('remote:host%2Fone:workspace-1');
    expect(mapped.blocks[0]).toMatchObject({ id: 'block-id', databaseId: 'remote:host%2Fone:database-1', viewId: 'view-id' });
    expect(mapped.blocks[0].sources?.[0].nodeId).toBe('remote:host%2Fone:source-node');
    expect(mapped.blocks[1]).toMatchObject({ id: 'link-id', pageId: 'remote:host%2Fone:page-2' });
    expect(mapped.blocks[2]).toMatchObject({ id: 'component-block', componentId: 'remote:host%2Fone:component-1' });
    expect(mapped.blocks[3]).toMatchObject({ id: 'text-id', text: 'page-1 database-1 node-1' });
  });

  it('maps database ownership while keeping column, row, and view IDs opaque', () => {
    const database = {
      id: 'database-1', workspaceId: 'workspace-1', title: 'DB', revision: 1, updatedAt: 1,
      columns: [{ id: 'column-id', name: 'Name', type: 'text' }],
      rows: [{ id: 'row-id', values: { 'column-id': 'remote:opaque' } }],
      views: [{ id: 'view-id', name: 'Custom', type: 'custom', config: { componentId: 'component-1', props: {}, filters: [], sorts: [], match: 'all' } }],
    } as unknown as PageDatabase;

    const mapped = mapDatabaseIdentity(database, 'host/one', 'renderer');
    expect(mapped.id).toBe('remote:host%2Fone:database-1');
    expect(mapped.workspaceId).toBe('remote:host%2Fone:workspace-1');
    expect(mapped.columns[0].id).toBe('column-id');
    expect(mapped.rows[0].id).toBe('row-id');
    expect(mapped.rows[0].values['column-id']).toBe('remote:opaque');
    expect(mapped.views[0].id).toBe('view-id');
    expect(mapped.views[0].config.componentId).toBe('remote:host%2Fone:component-1');
  });

  it('keeps change and batch IDs opaque while mapping owned resource references', () => {
    const change = {
      id: 'change-1', seq: 1, batchId: 'batch-1',
      target: { kind: 'database', databaseId: 'database-1' }, op: 'schema',
      before: null, after: null, forward: {}, inverse: {}, baseRev: 1, appliedRev: 2,
      previousHeadId: 'change-0',
      source: { kind: 'component', componentId: 'component-1', version: 1, databaseId: 'database-1', viewId: 'view-id' },
      proposalState: null, applicationState: 'applied', createdAt: 1, resolvedAt: null,
    } as unknown as PageChangeDto;

    const mapped = mapPageChangeIdentity(change, 'host/one', 'renderer');
    expect(mapped.id).toBe('change-1');
    expect(mapped.batchId).toBe('batch-1');
    expect(mapped.previousHeadId).toBe('change-0');
    expect(mapped.target).toEqual({ kind: 'database', databaseId: 'remote:host%2Fone:database-1' });
    expect(mapped.source).toMatchObject({ componentId: 'remote:host%2Fone:component-1', databaseId: 'remote:host%2Fone:database-1', viewId: 'view-id' });
  });
});
