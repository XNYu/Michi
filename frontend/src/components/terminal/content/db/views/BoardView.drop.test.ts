import { describe, expect, it } from 'vitest';
import type { MichiDbRow } from 'michi-shared';
import { boardLandingOrder, droppedBelow, eachRowOnce, landCard, landingCounts, landingHolds, type BoardLanding } from './BoardView';

const row = (id: string, status: unknown = 'doing', position = 0): MichiDbRow => ({ id, values: { status }, position, updatedAt: 0 }) as MichiDbRow;
const ids = (columns: readonly MichiDbRow[][]) => columns.map((rows) => rows.map((r) => r.id));
const POSITION = ['a', 'b', 'c', 'd', 'e', 'f'];
/** The database's own order; a test's view sort is its own. */
const byPosition = (rows: MichiDbRow[]) => [...rows].sort((x, y) => POSITION.indexOf(x.id) - POSITION.indexOf(y.id));
const NO_LIMIT = [200, 200, 200];

describe('a card put down on the board', () => {
  const groups = [
    { key: 'todo', rows: [row('a', 'todo')] },
    { key: 'doing', rows: [row('b'), row('d')] },
    { key: 'done', rows: [row('c', 'done'), row('e', 'done')] },
  ];
  const columns = groups.map((g) => g.rows);
  const moveD: BoardLanding = { row: row('d', 'done'), from: 'doing', to: 'done' };

  it('is drawn in the column it went to, where the view orders it, and leaves the one it came from', () => {
    const landed = landCard(groups, columns, moveD, byPosition, NO_LIMIT);
    expect(ids(landed)).toEqual([['a'], ['b'], ['c', 'd', 'e']]);
    // With its new value.
    expect(landed[2][1].values.status).toBe('done');
    // The columns it did not touch stay the same arrays.
    expect(landed[0]).toBe(columns[0]);
    // A view sorted the other way draws its columns that way, and puts the card by that sort.
    const reversed = (rows: MichiDbRow[]) => byPosition(rows).reverse();
    const sorted = groups.map((g) => ({ ...g, rows: reversed(g.rows) }));
    expect(ids(landCard(sorted, sorted.map((g) => g.rows), moveD, reversed, NO_LIMIT))[2]).toEqual(['e', 'd', 'c']);
  });

  it('keeps to the cards a full column draws', () => {
    const limits = [200, 200, 1];
    const paged = columns.map((rows, i) => rows.slice(0, limits[i]));
    // Done draws only its first card; d sorts after it, so it is one of the "N more".
    expect(ids(landCard(groups, paged, moveD, byPosition, limits))[2]).toEqual(['c']);
    // Sorted first, it is drawn and the last card drawn goes to "N more".
    const first = (rows: MichiDbRow[]) => [...rows.filter((r) => r.id === 'd'), ...byPosition(rows.filter((r) => r.id !== 'd'))];
    expect(ids(landCard(groups, paged, moveD, first, limits))[2]).toEqual(['d']);
  });

  it('counts in its new column, and changes nothing once Michi draws it there itself', () => {
    expect(landingCounts(groups, [moveD])).toEqual([0, -1, 1]);
    const michi = [groups[0], { key: 'doing', rows: [row('b')] }, { key: 'done', rows: [row('c', 'done'), row('d', 'done'), row('e', 'done')] }];
    const drawnByMichi = michi.map((g) => g.rows);
    landCard(michi, drawnByMichi, moveD, byPosition, NO_LIMIT).forEach((rows, i) => expect(rows).toBe(drawnByMichi[i]));
    expect(landingCounts(michi, [moveD])).toEqual([0, 0, 0]);
    expect(landingHolds(michi, moveD)).toBe(true);
  });

  it('lets go once Michi has the card somewhere else', () => {
    expect(landingHolds(groups, moveD)).toBe(true);
    const elsewhere = [{ key: 'todo', rows: [row('a', 'todo'), row('d', 'todo')] }, { key: 'doing', rows: [row('b')] }, groups[2]];
    expect(landingHolds(elsewhere, moveD)).toBe(false);
    expect(landingHolds(elsewhere, { row: row('d'), from: 'doing', to: 'doing', order: ['d', 'b'] })).toBe(false);
  });

  it('two put down before either is saved are both drawn where they went', () => {
    const moveB: BoardLanding = { row: row('b', 'todo'), from: 'doing', to: 'todo' };
    const landed = [moveD, moveB].reduce<MichiDbRow[][]>((cols, l) => landCard(groups, cols, l, byPosition, NO_LIMIT), columns);
    expect(ids(landed)).toEqual([['a', 'b'], [], ['c', 'd', 'e']]);
    expect(landingCounts(groups, [moveD, moveB])).toEqual([1, -2, 1]);
  });

  it('takes its new place inside its own column', () => {
    const list = ['b', 'd'];
    const next = boardLandingOrder(list, 'd', 'b');
    expect(next).toEqual(['d', 'b']);
    expect(ids(landCard(groups, columns, { row: row('d'), from: 'doing', to: 'doing', order: next! }, byPosition, NO_LIMIT))).toEqual([['a'], ['d', 'b'], ['c', 'e']]);
    // Put down where it was, or on nothing it knows: it does not move.
    expect(boardLandingOrder(list, 'd', 'd')).toBeNull();
    expect(boardLandingOrder(list, 'd', 'x')).toBeNull();
    // Below the cards: after the last one drawn.
    expect(boardLandingOrder(['d', 'b'], 'd', undefined)).toEqual(['b', 'd']);
  });
});

describe('a board’s card ids', () => {
  it('stay the same from column to column only while every row is in one column', () => {
    expect(eachRowOnce([{ rows: [row('a')] }, { rows: [row('b'), row('c')] }])).toBe(true);
    // A list a column kept when it became a select: the row is in two columns.
    expect(eachRowOnce([{ rows: [row('a', ['x', 'y'])] }, { rows: [row('b'), row('a', ['x', 'y'])] }])).toBe(false);
  });
});

// Carried 200px down (ghost top 220 -> 420) with the pointer from 500 to 700 (the activator event holds the start).
const pointer = { clientY: 500 } as unknown as Event;
const rect = (top: number) => ({ initial: { top: 220 }, translated: { top, height: 100 } });

describe('droppedBelow', () => {
  it('is not below the last card when let go on the heading', () => {
    expect(droppedBelow(600, { clientY: 40 } as unknown as Event, rect(-40))).toBe(false);
  });

  it('is below the last card when the pointer is under it, however deep the card was grabbed', () => {
    // The ghost top (420) is above the last card's bottom (600), the pointer (now 700) is under it.
    expect(droppedBelow(600, pointer, rect(420))).toBe(true);
  });

  it('is not below when the pointer is in the gap between cards', () => {
    expect(droppedBelow(760, pointer, rect(420))).toBe(false);
  });

  it('falls back to the ghost centre for the keyboard', () => {
    expect(droppedBelow(460, new Event('keydown'), rect(420))).toBe(true);
    expect(droppedBelow(480, new Event('keydown'), rect(420))).toBe(false);
  });
});
