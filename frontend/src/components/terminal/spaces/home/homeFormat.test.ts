import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeSectionItem, PageBlock, PageChangeDto, SpaceActivityItem } from 'michi-shared';
import { blockAuthor, homeChangesShown, homeDateLabel, homeRowAction, latestAgentWrite, splitHomeBlocks } from './homeFormat';
import { useZhCnDefaultLocale } from '../../../../test/zhCnLocale';

const block = (id: string, extra: Partial<PageBlock> = {}) => ({ id, rev: 1, type: 'markdown', text: id, ...extra }) as PageBlock;
const change = (seq: number, proposalState: PageChangeDto['proposalState'] = null) => ({ id: `c${seq}`, seq, proposalState }) as PageChangeDto;
const item = (target: HomeSectionItem['target']) => ({ id: 'x', kind: 'conversation', workspaceId: null, workspaceName: '', title: 't', at: null, summary: '', agentClaim: false, target }) as HomeSectionItem;

describe('the Spaces home date', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('is written in English the way Michi Home writes it, on a Chinese browser too', () => {
    useZhCnDefaultLocale();
    const friday = new Date(2026, 9, 23, 9, 30);
    expect(friday.toLocaleDateString(undefined, { weekday: 'short' })).toBe('周五');
    expect(homeDateLabel(friday)).toBe('Fri, Oct 23');
    expect(homeDateLabel(new Date(2026, 0, 4))).toBe('Sun, Jan 4');
  });
});

describe('home layout helpers', () => {
  it('places the counted sections after the lead, after the third block and after the fourth', () => {
    const blocks = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => block(id));
    const segments = splitHomeBlocks(blocks);
    expect(segments.lead.map((b) => b.id)).toEqual(['a']);
    expect(segments.middle.map((b) => b.id)).toEqual(['b', 'c']);
    expect(segments.beforeThreads.map((b) => b.id)).toEqual(['d']);
    expect(segments.rest.map((b) => b.id)).toEqual(['e', 'f']);
    expect(splitHomeBlocks([block('only')])).toEqual({ lead: [block('only')], middle: [], beforeThreads: [], rest: [] });
  });

  it('keeps a heading with the block under it', () => {
    const heading = (id: string) => block(id, { type: 'heading' } as Partial<PageBlock>);
    const blocks = [block('lead'), block('focus'), heading('ws-title'), block('ws-table'), heading('dec-title'), block('dec-list')];
    const segments = splitHomeBlocks(blocks);
    expect(segments.middle.map((b) => b.id)).toEqual(['focus', 'ws-title', 'ws-table']);
    expect(segments.beforeThreads.map((b) => b.id)).toEqual(['dec-title', 'dec-list']);
  });

  it('tells a person’s block from an agent’s', () => {
    expect(blockAuthor(block('a', { edit: { at: 1 } }))).toBe('human');
    expect(blockAuthor(block('a', { sources: [{ nodeId: 'n', turnId: 't', assistantId: 'a' }] }))).toBe('agent');
    expect(blockAuthor(block('a', { edit: { at: 1 }, sources: [{ nodeId: 'n', turnId: 't', assistantId: 'a' }] }))).toBe('human');
    expect(blockAuthor(block('a'))).toBeNull();
  });

  it('marks only what changed since the last visit, plus suggestions still waiting', () => {
    const shown = homeChangesShown([change(1), change(2, 'pending'), change(3, 'dismissed'), change(5), change(6, 'dismissed')], 4);
    expect(shown.map((c) => c.seq)).toEqual([2, 5, 6]);
  });

  it('names each row’s action by section and target', () => {
    const thread = item({ kind: 'conversation', nodeId: 'n', workspaceId: 'w', messageId: null });
    expect(homeRowAction('waiting', thread)).toBe('Back to chat');
    expect(homeRowAction('stalled', thread)).toBe('Continue');
    expect(homeRowAction('done', thread)).toBe('View chat');
    expect(homeRowAction(null, thread)).toBe('Open chat');
    expect(homeRowAction('waiting', item({ kind: 'page', pageId: 'p', blockId: null, changeId: 'c' }))).toBe('Review');
  });

  it('reads the last agent write from Space activity', () => {
    const change = (actor: 'user' | 'agent', workspaceName: string, at: number) => ({ kind: 'page-change', batchId: `${at}`, pageId: 'p', pageTitle: 'Home', workspaceId: '', workspaceName, at, count: 1, pending: 0, ops: [], summary: '', actor, sourceKind: actor === 'agent' ? 'chat' : 'user', sourceNodeId: null }) as SpaceActivityItem;
    expect(latestAgentWrite([change('user', 'sample-notes', 9), change('agent', 'rabbitholes', 8), change('agent', 'sample-notes', 7)])).toEqual({ workspaceName: 'rabbitholes', at: 8 });
    expect(latestAgentWrite([change('agent', '', 5)])).toEqual({ workspaceName: 'Home', at: 5 });
    expect(latestAgentWrite([])).toBeNull();
  });
});
