import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { MichiPageBlock, PageDto } from 'michi-shared';
import type { ApplyResult } from '../content/page/BlockFrame';
import { useBlockDecisions } from './useBlockDecisions';

const items = (a: boolean, b: boolean) => [{ text: 'Pack', done: a }, { text: 'Book', done: b }];
const checklist = (rev: number, a = false, b = false) => ({ type: 'checklist', id: 'b', rev, items: items(a, b) });
const compare = (rev: number, picked?: number) => ({ type: 'compare', id: 'c', rev, options: [{ name: 'Kanra' }, { name: 'Ace' }], ...(picked === undefined ? {} : { picked }) });
const page = (revision: number, blocks: unknown[]) => ({ id: 'p', workspaceId: 'w', revision, blocks }) as unknown as PageDto;
const ticks = (a: boolean, b: boolean): MichiPageBlock => ({ type: 'checklist', id: 'b', items: items(a, b) });
const pick = (picked?: number): MichiPageBlock => ({ type: 'compare', id: 'c', options: [{ name: 'Kanra' }, { name: 'Ace' }], ...(picked === undefined ? {} : { picked }) });
const update = (id: string, block: unknown, expectRev: number, revision: number) => [[{ op: 'update', id, block, expectRev }], revision];

function deferred() {
  let resolve!: (result: ApplyResult) => void;
  const promise = new Promise<ApplyResult>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(first: Promise<ApplyResult>, blocks: unknown[] = [checklist(1)]) {
  const onEdit = vi.fn().mockReturnValueOnce(first).mockResolvedValue('ok');
  const hook = renderHook(({ current }) => useBlockDecisions(current, onEdit, false), { initialProps: { current: page(1, blocks) } });
  return { onEdit, ...hook };
}

describe('decisions on a native page', () => {
  it('saves a second tick after the first, on the block the first made', async () => {
    const first = deferred();
    const { onEdit, result, rerender } = setup(first.promise);
    act(() => result.current.decide(ticks(false, false), ticks(true, false)));
    act(() => result.current.decide(ticks(true, false), ticks(true, true)));
    expect(onEdit.mock.calls).toEqual([update('b', { type: 'checklist', items: items(true, false) }, 1, 1)]);
    expect(result.current.display('b')).toEqual(ticks(true, true));
    // The first save reaches the page before its call returns; both ticks stay drawn meanwhile.
    rerender({ current: page(2, [checklist(2, true, false)]) });
    expect(result.current.display('b')).toEqual(ticks(true, true));
    await act(async () => { first.resolve('ok'); await first.promise; });
    expect(onEdit.mock.calls[1]).toEqual(update('b', { type: 'checklist', items: items(true, true) }, 2, 2));
    rerender({ current: page(3, [checklist(3, true, true)]) });
    expect(result.current.display('b')).toBeNull();
    expect(result.current.note).toBeNull();
  });

  it('saves decisions on two blocks one after the other, each on the page the one before left', async () => {
    const first = deferred();
    const { onEdit, result, rerender } = setup(first.promise, [checklist(1), compare(1)]);
    act(() => result.current.decide(ticks(false, false), ticks(true, false)));
    act(() => result.current.decide(pick(), pick(1)));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(result.current.display('c')).toEqual(pick(1));
    rerender({ current: page(2, [checklist(2, true, false), compare(1)]) });
    await act(async () => { first.resolve('ok'); await first.promise; });
    expect(onEdit.mock.calls[1]).toEqual(update('c', { type: 'compare', options: [{ name: 'Kanra' }, { name: 'Ace' }], picked: 1 }, 1, 2));
  });

  it('goes on after a save that changed nothing', async () => {
    const first = deferred();
    const { onEdit, result } = setup(first.promise);
    act(() => result.current.decide(ticks(false, false), ticks(false, false)));
    act(() => result.current.decide(ticks(false, false), ticks(false, true)));
    await act(async () => { first.resolve('ok'); await first.promise; });
    expect(onEdit.mock.calls[1]).toEqual(update('b', { type: 'checklist', items: items(false, true) }, 1, 1));
  });

  it('sends only the newest of the decisions made on a block while it waited', async () => {
    const first = deferred();
    const { onEdit, result, rerender } = setup(first.promise, [checklist(1), compare(1)]);
    act(() => result.current.decide(ticks(false, false), ticks(true, false)));
    act(() => result.current.decide(pick(), pick(0)));
    act(() => result.current.decide(pick(0), pick(1)));
    rerender({ current: page(2, [checklist(2, true, false), compare(1)]) });
    await act(async () => { first.resolve('ok'); await first.promise; });
    expect(onEdit).toHaveBeenCalledTimes(2);
    expect(onEdit.mock.calls[1]).toEqual(update('c', { type: 'compare', options: [{ name: 'Kanra' }, { name: 'Ace' }], picked: 1 }, 1, 2));
  });

  it('takes back a refused decision and says so on its block, until one on it saves', async () => {
    const onEdit = vi.fn().mockResolvedValue('stale');
    const { result } = renderHook(() => useBlockDecisions(page(1, [checklist(1)]), onEdit, false));
    await act(async () => { result.current.decide(ticks(false, false), ticks(true, false)); });
    expect(result.current.display('b')).toBeNull();
    expect(result.current.note).toEqual({ blockId: 'b', text: 'Not saved: the page changed meanwhile. Try again.' });
    onEdit.mockResolvedValue('ok');
    await act(async () => { result.current.decide(ticks(false, false), ticks(true, false)); });
    expect(result.current.note).toBeNull();
  });

  it('drops a waiting decision when someone else changed its block meanwhile', async () => {
    const first = deferred();
    const { onEdit, result, rerender } = setup(first.promise);
    act(() => result.current.decide(ticks(false, false), ticks(true, false)));
    act(() => result.current.decide(ticks(true, false), ticks(true, true)));
    rerender({ current: page(3, [checklist(3, false, false)]) });
    await act(async () => { first.resolve('ok'); await first.promise; });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(result.current.display('b')).toBeNull();
    expect(result.current.note?.text).toBe('Not saved: this block changed meanwhile. Check it and decide again.');
  });

  it('decides nothing on a read-only page', () => {
    const onEdit = vi.fn();
    const { result } = renderHook(() => useBlockDecisions(page(1, [checklist(1)]), onEdit, true));
    act(() => result.current.decide(ticks(false, false), ticks(true, false)));
    expect(onEdit).not.toHaveBeenCalled();
    expect(result.current.display('b')).toBeNull();
  });
});
