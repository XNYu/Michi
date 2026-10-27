import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PageBlock, PageChangeDto } from 'michi-shared';
import { ChangeCard } from './ChangeCard';

const location = { parentId: null, slot: null, previousId: null, nextId: null };

function proposal(before: PageBlock, after: PageBlock): PageChangeDto {
  return {
    id: 'chg-1', seq: 1, batchId: 'batch-1', target: { kind: 'block', pageId: 'pg-1', blockId: before.id }, op: 'update',
    before: { kind: 'block', exists: true, block: before, location }, after: { kind: 'block', exists: true, block: after, location },
    forward: { kind: 'block', op: 'upsert', block: after, location }, inverse: { kind: 'block', op: 'upsert', block: before, location },
    baseRev: 1, appliedRev: null, previousHeadId: null, source: { kind: 'chat', nodeId: 'node-1', turnId: 'turn-1', assistantId: 'msg-1' },
    proposalState: 'pending', applicationState: null, createdAt: Date.now(), resolvedAt: null,
  };
}

function preview(before: PageBlock, after: PageBlock): string {
  const { container } = render(<ChangeCard change={proposal(before, after)} onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} />);
  return container.querySelector('.page-change-preview')?.textContent ?? '';
}

describe('ChangeCard previews of structured blocks', () => {
  it('shows the proposed metrics, next steps and timeline as lines', () => {
    expect(preview(
      { id: 'm', rev: 1, type: 'metrics', items: [{ label: 'Branches', value: '6' }] },
      { id: 'm', rev: 2, type: 'metrics', items: [{ label: 'Branches', value: '7', note: 'In dev' }] },
    )).toBe('Branches · 7 · In dev');
    expect(preview(
      { id: 'n', rev: 1, type: 'next-steps', title: 'Next', items: [] },
      { id: 'n', rev: 2, type: 'next-steps', title: 'Next', items: [{ who: 'user', text: 'Confirm', unblocks: 'Notes' }, { who: 'agent', text: 'Test' }] },
    )).toBe('Next\nYou · Confirm → Notes\nAgent · Test');
    expect(preview(
      { id: 't', rev: 1, type: 'timeline', items: [] },
      { id: 't', rev: 2, type: 'timeline', title: 'Progress', items: [{ title: 'Merged', at: 0, detail: 'Green' }] },
    )).toBe('Progress\nMerged · Green');
  });
});

describe('ChangeCard inline suggestion', () => {
  const card = (before: PageBlock, after: PageBlock) => render(<ChangeCard variant="inline" change={proposal(before, after)}
    onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} />).container;

  it('strikes and inserts only the changed lines, formatted, without repeating a shared heading', () => {
    const view = card(
      { id: 'b', rev: 1, type: 'markdown', text: '#### 我写的\n\n示例项目只做两件事：发布节奏稳定下来，示例笔记整理好。别的先放。' },
      { id: 'b', rev: 2, type: 'markdown', text: '#### 我写的\n\n示例项目只做两件事：**发布节奏**稳定下来，示例笔记整理好，外加一份使用指南。别的先放。' },
    );
    const old = view.querySelector('.page-change-prop__old')!;
    const added = view.querySelector('.page-change-prop__new')!;
    expect(old.textContent?.trim()).toBe('示例项目只做两件事：发布节奏稳定下来，示例笔记整理好。别的先放。');
    expect(added.textContent?.trim()).toBe('示例项目只做两件事：发布节奏稳定下来，示例笔记整理好，外加一份使用指南。别的先放。');
    expect(added.querySelector('strong')?.textContent).toBe('发布节奏');
    expect(view.querySelector('.page-change-prop__body')!.textContent).not.toMatch(/####|我写的|\*\*/);
  });

  it('shows a changed callout line with its inline marks and keeps the unchanged title out', () => {
    const view = card(
      { id: 'c', rev: 1, type: 'callout', title: '预算', text: '已花 ¥9,800 / 预算 ¥14,000。\n住宿已订。' },
      { id: 'c', rev: 2, type: 'callout', title: '预算', text: '已花 **¥11,600** / 预算 ¥14,000。\n住宿已订。' },
    );
    expect(view.querySelector('.page-change-prop__old')!.textContent).toBe('已花 ¥9,800 / 预算 ¥14,000。');
    expect(view.querySelector('.page-change-prop__new strong')?.textContent).toBe('¥11,600');
    expect(view.querySelector('.page-change-prop__body')!.textContent).not.toMatch(/预算$|住宿/);
  });

  it('shows the whole new text when only something besides the text changed', () => {
    const view = card(
      { id: 'c', rev: 1, type: 'callout', tone: 'info', title: 'Note', text: 'Same words' },
      { id: 'c', rev: 2, type: 'callout', tone: 'warn', title: 'Note', text: 'Same words' },
    );
    expect(view.querySelector('.page-change-prop__old')).toBeNull();
    expect(view.querySelector('.page-change-prop__new')!.textContent).toBe('NoteSame words');
  });
});

describe('ChangeCard inline source', () => {
  const block: PageBlock = { id: 'b', rev: 2, type: 'markdown', text: 'Shipped' };
  const applied = (source: PageChangeDto['source']): PageChangeDto => ({
    ...proposal({ ...block, rev: 1, text: 'Draft' }, block), source, proposalState: null, applicationState: 'applied', appliedRev: 2,
  });
  const run = { nodeId: 'run-node', turnId: 'run-turn', assistantId: 'run-msg' };
  const read = { nodeId: 'chat-node', turnId: 'chat-turn', assistantId: 'chat-msg' };

  it('links background maintenance to the conversation message it read, named by that conversation', () => {
    const onOpenSource = vi.fn();
    const sourceLabel = vi.fn((source: PageChangeDto['source']) => (source.kind === 'chat' && source.nodeId === 'chat-node' ? '排查公证失败' : 'Meta agent'));
    const { getByRole } = render(<ChangeCard variant="inline" change={applied({ kind: 'maintenance', ...run, jobId: 'job', runId: 'run', evidence: [read] })}
      sourceLabel={sourceLabel} onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={onOpenSource} />);
    getByRole('button', { name: '“排查公证失败”' }).click();
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'chat', ...read });
  });

  it('falls back to the run when a maintenance change cites no conversation', () => {
    const onOpenSource = vi.fn();
    const { getByRole } = render(<ChangeCard variant="inline" change={applied({ kind: 'maintenance', ...run, jobId: 'job', runId: 'run', evidence: [] })}
      onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={onOpenSource} />);
    getByRole('button', { name: 'the Meta agent' }).click();
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'chat', ...run });
  });

  const titles: Record<string, string> = { 'chat-node': '排查公证失败', 'notes-node': '发布说明草稿', 'incr-node': 'Pages 增量读取边界', 'cr-node': '审查 CR' };
  const byTitle = (source: PageChangeDto['source']) => (source.kind === 'chat' ? titles[source.nodeId] : undefined);
  const line = (source: PageChangeDto['source'], onOpenSource = vi.fn()) => render(<ChangeCard variant="inline" change={applied(source)} sourceLabel={byTitle}
    onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={onOpenSource} />);
  const maintenance = (evidence: Array<{ nodeId: string; turnId: string; assistantId: string; messageId?: string }>, read?: { kind: 'conversations' | 'workspace-homes'; count: number }) =>
    ({ kind: 'maintenance' as const, ...run, jobId: 'job', runId: 'run', evidence, ...(read ? { read } : {}) });
  const fromText = (container: HTMLElement) => container.querySelector('.page-change-line')!.textContent!.split('·').map((part) => part.trim()).find((part) => part.startsWith('from'));

  it('names each conversation a block cites and opens the exact message, the user\'s own included', () => {
    const onOpenSource = vi.fn();
    const notes = { nodeId: 'notes-node', turnId: 'notes-turn', assistantId: 'notes-reply', messageId: 'notes-question' };
    const { container, getByRole } = line(maintenance([read, notes], { kind: 'conversations', count: 3 }), onOpenSource);
    expect(fromText(container)).toBe('from “排查公证失败” and “发布说明草稿”');
    getByRole('button', { name: '“发布说明草稿”' }).click();
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'chat', nodeId: 'notes-node', turnId: 'notes-turn', assistantId: 'notes-question' });
  });

  it('shortens a long list of cited conversations', () => {
    const cite = (nodeId: string) => ({ nodeId, turnId: `${nodeId}-t`, assistantId: `${nodeId}-a` });
    const { container } = line(maintenance(['chat-node', 'notes-node', 'incr-node', 'cr-node'].map(cite), { kind: 'conversations', count: 4 }));
    expect(fromText(container)).toBe('from “排查公证失败”, “发布说明草稿” and 2 more');
  });

  it('names a conversation once when a block cites several of its messages', () => {
    const onOpenSource = vi.fn();
    const later = { nodeId: 'chat-node', turnId: 'later-turn', assistantId: 'later-reply' };
    const { container, getByRole } = line(maintenance([read, later], { kind: 'conversations', count: 1 }), onOpenSource);
    expect(fromText(container)).toBe('from “排查公证失败”');
    getByRole('button', { name: '“排查公证失败”' }).click();
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'chat-node', turnId: read.turnId }));
  });

  it('says what the run read, without a quoted source, when a block cites no single message', () => {
    const first = line(maintenance([], { kind: 'conversations', count: 3 }));
    expect(fromText(first.container)).toBe('from 3 conversations');
    expect(first.queryByRole('button', { name: /conversation/ })).toBeNull();
    first.unmount();
    expect(fromText(line(maintenance([], { kind: 'workspace-homes', count: 5 })).container)).toBe('from 5 workspace homes');
  });

  it('reads a block written before blocks named their sources as coming from every conversation that run read', () => {
    const { container } = line(maintenance([read, { nodeId: 'notes-node', turnId: 'nt', assistantId: 'na' }]));
    expect(fromText(container)).toBe('from 2 conversations');
  });
});
