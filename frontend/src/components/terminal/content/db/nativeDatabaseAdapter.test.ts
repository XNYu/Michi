import { describe, expect, it } from 'vitest';
import type { PageDatabase } from 'michi-shared';
import { pageDatabaseForMichiView, pageDatabaseOps, pageViewOps } from './nativeDatabaseAdapter';

const database: PageDatabase = {
  id: 'db-native', workspaceId: 'ws-1', title: 'Plan', revision: 12, updatedAt: 40,
  columns: [{ id: 'title', name: 'Title', type: 'text' }],
  views: [{ id: 'table', name: 'Table', type: 'table', position: 0, config: { filters: [], match: 'all', sorts: [] } }],
  rows: [{ id: 'row-1', values: { title: 'Draft' }, body: 'Notes', position: 0, updatedAt: 30, rev: 7, edited: { title: 25 }, bodyEditedAt: 26 }],
};

describe('native database presentation adapter', () => {
  it('keeps native row revisions and ownership metadata in the presentation object', () => {
    const displayed = pageDatabaseForMichiView(database);
    expect(displayed).toMatchObject({ id: 'db-native', title: 'Plan', kind: 'user' });
    expect(displayed.rows[0]).toMatchObject({ rev: 7, edited: { title: 25 }, bodyEditedAt: 26, body: 'Notes' });
    expect(displayed.rows[0]).not.toBe(database.rows[0]);
  });

  it('adds the native row revision to row writes without losing the database-level write payload', () => {
    expect(pageDatabaseOps([
      { op: 'row.update', id: 'row-1', values: { title: 'Changed' } },
      { op: 'row.delete', id: 'row-1' },
    ], database)).toEqual([
      { op: 'row.update', id: 'row-1', values: { title: 'Changed' }, expectRev: 7 },
      { op: 'row.delete', id: 'row-1', expectRev: 7 },
    ]);
  });

  it('rejects edits to rows missing from the authoritative snapshot', () => {
    expect(() => pageDatabaseOps([{ op: 'row.delete', id: 'gone' }], database))
      .toThrow('This row changed. Refresh the database and try again.');
  });

  it('converts every view type, and component-backed custom views, but not Michi widget settings', () => {
    const customConfig = {
      filters: [], match: 'all' as const, sorts: [], componentId: 'cmp-1', pinnedVersion: 2,
      props: { density: 'compact' }, height: 420,
    };
    expect(pageDatabaseOps([{
      op: 'view.save',
      view: { id: 'custom-1', name: 'Custom', type: 'custom', config: customConfig },
    }], database)).toEqual([{
      op: 'view.save',
      view: { id: 'custom-1', name: 'Custom', type: 'custom', config: customConfig },
    }]);
    for (const type of ['list', 'calendar', 'gallery', 'timeline'] as const) {
      const config = { filters: [], match: 'all' as const, sorts: [], date: 'due', planDate: 'plan', cover: 'photo' };
      expect(pageDatabaseOps([{ op: 'view.save', view: { name: type, type, config } }], database))
        .toEqual([{ op: 'view.save', view: { name: type, type, config } }]);
    }
    expect(() => pageDatabaseOps([{
      op: 'view.save', view: { name: 'Widget', type: 'table', config: { filters: [], match: 'all', sorts: [], code: 'x' } },
    }], database)).toThrow('The code view setting is not supported in native Pages.');
  });

  it('keeps a task database’s role, and gives other databases none', () => {
    expect(pageDatabaseForMichiView({ ...database, role: 'tasks' }).role).toBe('tasks');
    expect('role' in pageDatabaseForMichiView(database)).toBe(false);
  });

  it('passes view changes through for a list of views of its own', () => {
    const save = { op: 'view.save' as const, view: { name: 'By workspace', type: 'board' as const, config: { filters: [], match: 'all' as const, sorts: [], group: 'workspace' } } };
    expect(pageViewOps([{ op: 'view.delete', id: 'v1' }, save])).toEqual([{ op: 'view.delete', id: 'v1' }, save]);
    expect(() => pageViewOps([{ op: 'row.delete', id: 'r1' }])).toThrow(/Only view changes/);
  });
});
