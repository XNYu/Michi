import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MichiDatabase, MichiDbRow } from 'michi-shared';
import { DatabaseView } from '../DatabaseView';
import { userDatabase } from '../dbTestData';

const NOW = new Date(2026, 9, 21, 15, 0).getTime();

function board(group: string, rows?: MichiDbRow[]): MichiDatabase {
  const db = userDatabase();
  return { ...db, rows: rows ?? db.rows, views: [{ ...db.views[0], id: 'board', type: 'board', config: { filters: [], match: 'all', sorts: [], group } }] };
}

const view = (db: MichiDatabase) => <DatabaseView db={db} edit={vi.fn(async () => true)} viewId={null} onViewChange={vi.fn()} threadOf={() => undefined} now={NOW} />;
const card = (name: string) => [...document.querySelectorAll<HTMLElement>('.michi-card')].find((el) => el.textContent?.includes(name))!;
const lifted = () => [...document.querySelectorAll<HTMLElement>('.michi-card')].filter((el) => el.style.zIndex === '1');
const leavingCounts = () => document.querySelectorAll('.michi-db-group__count [aria-hidden="true"]').length;

describe('board motion', () => {
  it('raises a card that another edit moves to a new column above the cards it passes', () => {
    const db = board('c_pri');
    const { rerender } = render(view(db));
    expect(lifted()).toHaveLength(0);
    rerender(view({ ...db, rows: db.rows.map((r) => (r.id === 'r2' ? { ...r, values: { ...r.values, c_pri: 'High' } } : r)) }));
    expect(card('Pack').dataset.column).toBe('High');
    expect(lifted().map((el) => el.textContent)).toEqual([expect.stringContaining('Pack')]);
  });

  it('draws a regrouped board settled: no card arrives, no count rolls', () => {
    const db = board('c_pri');
    const { rerender } = render(view(db));
    rerender(view(board('c_done')));
    expect(card('Pack').dataset.column).toBe('false');
    expect(lifted()).toHaveLength(0);
    expect(leavingCounts()).toBe(0);
  });

  it('draws a row that sits in two columns in both, each its own card', () => {
    // A list the Priority column kept when it was a multi-select.
    const rows = userDatabase().rows.map((r) => (r.id === 'r1' ? { ...r, values: { ...r.values, c_pri: ['High', 'Low'] } } : r));
    render(view(board('c_pri', rows)));
    const hotel = [...document.querySelectorAll<HTMLElement>('.michi-card')].filter((el) => el.textContent?.includes('Book the hotel'));
    expect(hotel.map((el) => el.dataset.column)).toEqual(['High', 'Low']);
  });
});
