import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageBlock, PageChangeDto } from 'michi-shared';

const pages = vi.hoisted(() => ({ fetchPage: vi.fn(), listPageChanges: vi.fn(), pagesFetch: vi.fn(), readPagesJson: vi.fn() }));
vi.mock('../../services/api/pages', () => pages);

import { blockName, citesMessage, describePageReference } from './sourceApi';

const block = (id: string, extra: Record<string, unknown>) => ({ id, rev: 1, ...extra }) as unknown as PageBlock;
const change = (blockId: string, source: Record<string, unknown>) => ({ target: { kind: 'block', pageId: 'p1', blockId }, source }) as unknown as PageChangeDto;

beforeEach(() => { for (const fn of Object.values(pages)) fn.mockReset(); });

describe('source api', () => {
  it('names a block by its title or heading, else the heading above it, else its first words', () => {
    const blocks = [
      block('h', { type: 'heading', text: '风险' }),
      block('a', { type: 'markdown', text: '公证不过就只能发未签名包，早期用户需要在系统设置里手动放行。' }),
      block('c', { type: 'callout', title: '进展', text: '12 项里完成 8 项' }),
      block('m', { type: 'markdown', text: '#### 目标\n\n把 示例预览版交给少量示例用户' }),
    ];
    expect(blocks.map((b) => blockName(b, blocks))).toEqual(['风险', '风险', '进展', '目标']);
    expect(blockName(blocks[1], [blocks[1]])).toBe('公证不过就只能发未签名包，早期用…');
  });

  it('names a chart or a conflict by its own title or question, and survives a block type it does not know', () => {
    const blocks = [
      block('h', { type: 'heading', text: '进展' }),
      block('k', { type: 'conflict', question: '11 月 3 日去哪？', options: [{ text: '岚山' }, { text: '奈良' }] }),
      block('t', { type: 'chart', title: '每天的回合数', kind: 'bar', labels: ['14'], series: [{ label: 'Kiro', values: [3] }] }),
      block('m', { type: 'metrics', items: [{ label: '完成', value: '14 / 22' }] }),
      block('x', { type: 'from-a-newer-backend', title: '新块' }),
    ];
    expect(blocks.map((b) => blockName(b, blocks))).toEqual(['进展', '11 月 3 日去哪？', '每天的回合数', '进展', '进展']);
  });

  it('a change cites a message as its chat source or as maintenance evidence', () => {
    expect(citesMessage(change('b', { kind: 'chat', nodeId: 'n', turnId: 't', assistantId: 'm4' }), 'm4')).toBe(true);
    expect(citesMessage(change('b', { kind: 'maintenance', nodeId: 'run', turnId: 't', assistantId: 'r', evidence: [{ nodeId: 'n', turnId: 't', assistantId: 'm4' }] }), 'm4')).toBe(true);
    expect(citesMessage(change('b', { kind: 'user' }), 'm4')).toBe(false);
  });

  it('a maintenance change that cites the user message marks that message, not the reply', () => {
    const cited = change('b', { kind: 'maintenance', nodeId: 'run', turnId: 't', assistantId: 'r',
      evidence: [{ nodeId: 'n', turnId: 't', assistantId: 'm4', messageId: 'u3' }] });
    expect(citesMessage(cited, 'u3')).toBe(true);
    expect(citesMessage(cited, 'm4')).toBe(false);
  });

  it('describes the blocks that cite a user message', async () => {
    pages.fetchPage.mockResolvedValue({ blocks: [block('g', { type: 'heading', text: '目标' }), block('r', { type: 'heading', text: '风险' })] });
    pages.listPageChanges.mockResolvedValue({ changes: [
      change('r', { kind: 'maintenance', nodeId: 'run', turnId: 't', assistantId: 'r', evidence: [{ nodeId: 'n', turnId: 't', assistantId: 'm4', messageId: 'u3' }] }),
      change('g', { kind: 'maintenance', nodeId: 'run', turnId: 't', assistantId: 'r', evidence: [{ nodeId: 'n', turnId: 't', assistantId: 'm4' }] }),
    ] });
    const page = { backendConnectionId: 'local', workspaceId: 'ws-1', pageId: 'p1' };
    expect(await describePageReference(page, 'u3')).toBe('风险');
    expect(await describePageReference(page, 'm4')).toBe('目标');
  });

  it('describes the citing blocks in page order, once each', async () => {
    pages.fetchPage.mockResolvedValue({ blocks: [
      block('g', { type: 'markdown', text: '#### 目标\n\n…' }), block('p', { type: 'callout', title: '进展', text: '…' }), block('r', { type: 'markdown', text: '#### 风险\n\n…' }),
    ] });
    pages.listPageChanges.mockResolvedValue({ changes: [
      change('r', { kind: 'chat', assistantId: 'm4' }), change('p', { kind: 'chat', assistantId: 'm4' }),
      change('r', { kind: 'chat', assistantId: 'm4' }), change('g', { kind: 'chat', assistantId: 'other' }),
    ] });
    const page = { backendConnectionId: 'local', workspaceId: 'ws-1', pageId: 'p1' };
    expect(await describePageReference(page, 'm4')).toBe('进展, 风险');
    expect(pages.listPageChanges).toHaveBeenCalledWith('p1', expect.objectContaining({ direction: 'backward', limit: 100 }));
    expect(await describePageReference(page, 'none')).toBeNull();
  });
});
