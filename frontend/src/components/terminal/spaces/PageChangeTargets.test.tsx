import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PageChangeDto } from 'michi-shared';
import { PageChangeTargets, pageChangesForTarget } from './PageChangeTargets';

function rowChange(id: string, seq: number, rowId: string, source: PageChangeDto['source'], proposalState: PageChangeDto['proposalState'], applicationState: PageChangeDto['applicationState']): PageChangeDto {
  return {
    id, seq, batchId: `batch-${id}`, target: { kind: 'row', databaseId: 'db-1', rowId, columnIds: ['status'] }, op: 'row',
    before: { kind: 'row', exists: true, row: { id: rowId, rev: seq, values: { status: 'Todo' }, body: '', position: 0, updatedAt: seq, edited: {}, bodyEditedAt: null }, location: { position: 0, after: null } },
    after: { kind: 'row', exists: true, row: { id: rowId, rev: seq + 1, values: { status: 'Done' }, body: '', position: 0, updatedAt: seq + 1, edited: {}, bodyEditedAt: null }, location: { position: 0, after: null } },
    forward: { kind: 'row', op: 'patch', id: rowId, values: { status: 'Done' } },
    inverse: { kind: 'row', op: 'patch', id: rowId, values: { status: 'Todo' } },
    baseRev: seq, appliedRev: applicationState === 'applied' ? seq + 1 : null, previousHeadId: null, source,
    proposalState, applicationState, createdAt: seq, resolvedAt: null,
  };
}

const chat = { kind: 'chat', nodeId: 'node-1', turnId: 'turn-1', assistantId: 'msg-1' } as const;
const user = { kind: 'user' } as const;

describe('database target change cards', () => {
  it('shows only the latest actionable non-user change per row beside the database', () => {
    const staleAgent = rowChange('older-agent', 1, 'row-1', chat, null, 'applied');
    const latestHuman = rowChange('newer-human', 2, 'row-1', user, null, 'applied');
    const pendingRow = rowChange('pending-row', 3, 'row-2', chat, 'pending', null);
    expect(pageChangesForTarget([staleAgent, latestHuman, pendingRow], { kind: 'database', databaseId: 'db-1' }).map((change) => change.id)).toEqual(['pending-row']);
    const onAccept = vi.fn();
    render(<PageChangeTargets changes={[staleAgent, latestHuman, pendingRow]} target={{ kind: 'database', databaseId: 'db-1' }} onAccept={onAccept} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} loading={false} error={null} />);
    expect(screen.getByText('Suggested field update')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ id: 'pending-row' }));
  });

  it('keeps unresolved proposals visible even when a later user edit makes one stale', () => {
    const proposal = rowChange('proposal', 1, 'row-1', chat, 'pending', null);
    const laterUserEdit = rowChange('human-update', 2, 'row-1', user, null, 'applied');
    expect(pageChangesForTarget([proposal, laterUserEdit], { kind: 'database', databaseId: 'db-1' }).map((change) => change.id)).toEqual(['proposal']);
  });

  it('omits applied source/undo footers while keeping pending suggestions actionable', () => {
    const change = rowChange('written', 1, 'row-1', chat, null, 'applied');
    const onRevert = vi.fn();
    const onOpenSource = vi.fn();
    const onAccept = vi.fn();
    const props = { target: { kind: 'database' as const, databaseId: 'db-1' }, onAccept, onRevert, onOpenSource,
      onDismiss: vi.fn(), onReopen: vi.fn(), onRedo: vi.fn(), loading: false, error: null, quiet: true };
    const view = render(<PageChangeTargets {...props} changes={[change]} />);
    expect(screen.queryByText('Agent updated')).toBeNull();
    expect(view.container.querySelector('time')).toBeNull();
    expect(view.container.childElementCount).toBe(0);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    view.rerender(<PageChangeTargets {...props} changes={[{ ...change, proposalState: 'pending', applicationState: null }]} />);
    expect(screen.getByText('Suggested field update')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'the conversation' })).toBeNull();
    expect(view.container.querySelector('[data-quiet]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ id: 'written', proposalState: 'pending' }));
  });

  it('keeps deleted block proposal history addressable as a tombstone target', () => {
    const deleted: PageChangeDto = {
      id: 'deleted-block', seq: 10, batchId: 'delete-batch', target: { kind: 'block', pageId: 'page-1', blockId: 'gone-block' }, op: 'delete',
      before: { kind: 'block', exists: true, block: { type: 'markdown', id: 'gone-block', rev: 4, text: 'Old content' }, location: { parentId: null, slot: null, previousId: null, nextId: null } },
      after: { kind: 'block', exists: false, id: 'gone-block', location: null },
      forward: { kind: 'block', op: 'delete', id: 'gone-block', expectedLocation: { parentId: null, slot: null, previousId: null, nextId: null } },
      inverse: { kind: 'block', op: 'upsert', block: { type: 'markdown', id: 'gone-block', rev: 4, text: 'Old content' }, location: { parentId: null, slot: null, previousId: null, nextId: null } },
      baseRev: 4, appliedRev: null, previousHeadId: null, source: chat, proposalState: 'pending', applicationState: null, createdAt: 10, resolvedAt: null,
    };
    render(<PageChangeTargets changes={[deleted]} target={{ kind: 'block', pageId: 'page-1', blockId: 'gone-block' }} onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} loading={false} error={null} />);
    expect(screen.getByRole('article', { name: /^Suggested deletion of/ })).toBeTruthy();
    expect(screen.getByText('Suggested removal')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
  });
});

describe('block change line before and after undo', () => {
  const location = { parentId: null, slot: null, previousId: null, nextId: null };
  const blockChange = (id: string, seq: number, source: PageChangeDto['source'], applicationState: PageChangeDto['applicationState'], text: string, beforeText: string | null): PageChangeDto => {
    const after = { type: 'markdown' as const, id: 'b', rev: seq + 1, text };
    const before = beforeText === null ? null : { type: 'markdown' as const, id: 'b', rev: seq, text: beforeText };
    return {
      id, seq, batchId: `batch-${id}`, target: { kind: 'block', pageId: 'page-1', blockId: 'b' }, op: before ? 'update' : 'insert',
      before: before ? { kind: 'block', exists: true, block: before, location } : { kind: 'block', exists: false, id: 'b', location: null },
      after: { kind: 'block', exists: true, block: after, location },
      forward: { kind: 'block', op: 'upsert', block: after, location },
      inverse: before ? { kind: 'block', op: 'upsert', block: before, location } : { kind: 'block', op: 'delete', id: 'b', expectedLocation: location },
      baseRev: seq, appliedRev: seq + 1, previousHeadId: null, source, proposalState: null, applicationState, createdAt: Date.now(), resolvedAt: null,
    };
  };
  const firstRun: PageChangeDto['source'] = { kind: 'maintenance', nodeId: 'run', turnId: 'run-t', assistantId: 'run-a', jobId: 'j', runId: 'r',
    evidence: [{ nodeId: 'notarize', turnId: 'nt', assistantId: 'na' }], read: { kind: 'conversations', count: 3 } };
  const window: PageChangeDto['source'] = { kind: 'chat', nodeId: 'assistant', turnId: 'at', assistantId: 'aa' };
  const titles: Record<string, string> = { notarize: '排查公证失败', assistant: 'Assistant' };
  const label = (source: PageChangeDto['source']) => (source.kind === 'chat' ? titles[source.nodeId] : undefined);
  const lineOf = (changes: PageChangeDto[], history?: PageChangeDto[]) => {
    const view = render(<PageChangeTargets changes={changes} history={history} target={{ kind: 'block', pageId: 'page-1', blockId: 'b' }} sourceLabel={label}
      onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} loading={false} error={null} />);
    const line = view.container.querySelector('.page-change-line')!;
    const text = Array.from(line.childNodes).map((node) => node.textContent?.trim()).filter(Boolean).join(' ').replace(/(just now|\d+[mhd] ago)/, '<time>');
    view.unmount();
    return text;
  };

  it('names where the content came from before the undo, and keeps that source after it, with Undo then Restore', () => {
    const written = blockChange('first', 1, firstRun, 'applied', '4 steps', null);
    const edited = blockChange('window', 2, window, 'applied', '5 steps', '4 steps');
    expect(lineOf([written, edited])).toBe('Agent updated · <time> · from “Assistant” · Undo');
    const undone = { ...edited, applicationState: 'reverted' as const };
    expect(lineOf([written, undone])).toBe('Undone · <time> · from “排查公证失败” · Restore');
    // A home shows only recent changes; the page's full history still names the earlier source.
    expect(lineOf([undone], [written, undone])).toBe('Undone · <time> · from “排查公证失败” · Restore');
    // Nothing earlier is loaded: the undone change keeps its own source.
    expect(lineOf([undone])).toBe('Undone · <time> · from “Assistant” · Restore');
  });

  it('names no source after undoing a change to what a person wrote', () => {
    const typed = blockChange('typed', 1, { kind: 'user' }, 'applied', 'mine', null);
    const undone = blockChange('window', 2, window, 'reverted', 'theirs', 'mine');
    expect(lineOf([typed, undone])).toBe('Undone · <time> · Restore');
  });
});

describe('an answered suggestion', () => {
  const props = { target: { kind: 'database' as const, databaseId: 'db-1' }, onAccept: vi.fn(), onDismiss: vi.fn(), onReopen: vi.fn(),
    onRevert: vi.fn(), onRedo: vi.fn(), onOpenSource: vi.fn(), loading: false, error: null, quiet: true };
  const pending = rowChange('suggested', 1, 'row-1', chat, 'pending', null);

  it('holds the chosen action while the rest fade, then collapses away, out of reach while it goes', async () => {
    const view = render(<PageChangeTargets {...props} changes={[pending]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const card = view.container.querySelector('.page-change-prop')!;
    expect(card.getAttribute('data-chosen')).toBe('dismiss');
    expect(screen.getByRole('button', { name: 'Dismiss' }).getAttribute('data-chosen')).toBe('true');
    // Answered once: no second answer while it resolves.
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<PageChangeTargets {...props} changes={[{ ...pending, proposalState: 'dismissed' }]} />);
    const leaving = view.container.querySelector('.page-change-targets');
    if (leaving) expect(leaving.getAttribute('aria-hidden') ?? leaving.querySelector('[aria-hidden="true"]')).toBeTruthy();
    await waitFor(() => expect(view.container.querySelector('.page-change-targets')).toBeNull());
  });

  it('takes its buttons back when the answer is refused', () => {
    const view = render(<PageChangeTargets {...props} changes={[pending]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(view.container.querySelector('.page-change-prop')!.getAttribute('data-chosen')).toBe('accept');
    view.rerender(<PageChangeTargets {...props} error="Could not save" changes={[pending]} />);
    expect(view.container.querySelector('.page-change-prop')!.getAttribute('data-chosen')).toBeNull();
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('takes its buttons back when the answer settles and the suggestion still waits', async () => {
    let settle!: () => void;
    const onAccept = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const view = render(<PageChangeTargets {...props} onAccept={onAccept} changes={[pending]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true);
    // Michi answered without an error and without resolving it (a stale page, a raced reopen).
    await act(async () => { settle(); });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(false));
    expect(view.container.querySelector('.page-change-prop')!.getAttribute('data-chosen')).toBeNull();
  });

  it('can be answered again once it is shown again', () => {
    const open = { ...props, quiet: false, onDismiss: vi.fn(() => new Promise<void>(() => {})) };
    const view = render(<PageChangeTargets {...open} changes={[pending]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    view.rerender(<PageChangeTargets {...open} changes={[{ ...pending, proposalState: 'dismissed', resolvedAt: 5 }]} />);
    view.rerender(<PageChangeTargets {...open} changes={[{ ...pending, resolvedAt: null }]} />);
    expect(view.container.querySelector('.page-change-prop')!.getAttribute('data-chosen')).toBeNull();
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
