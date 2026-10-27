import type { MichiDatabase, MichiDbEditOp, MichiDbNewView } from 'michi-shared';
import type { PageDatabase, PageDatabaseEditOp, PageDatabaseNewView, PageDatabaseView } from 'michi-shared';

/** Presentation-only conversion. Row revision and human ownership metadata are
 * carried through unchanged so callers can build conflict-checked writes. */
export function pageDatabaseForMichiView(database: PageDatabase): MichiDatabase {
  return {
    id: database.id,
    title: database.title,
    kind: 'user',
    ...(database.role ? { role: database.role } : {}),
    columns: database.columns.map((column) => ({ ...column })),
    views: database.views.map((view) => ({ ...view, config: { ...view.config } })),
    rows: database.rows.map((row) => ({ ...row, values: { ...row.values }, edited: { ...row.edited } })),
    updatedAt: database.updatedAt,
  };
}

/** Attach each row's native revision to row writes before submitting the
 * database-level revision-checked batch through usePageDatabase.edit(). */
export function pageDatabaseOps(
  ops: MichiDbEditOp[],
  database: PageDatabase,
): PageDatabaseEditOp[] {
  return ops.map((op): PageDatabaseEditOp => {
    if (op.op === 'view.save') return nativeViewSave(op.view);
    if (op.op === 'row.update' || op.op === 'row.delete') {
      const row = database.rows.find((candidate) => candidate.id === op.id);
      if (!row) throw new Error('This row changed. Refresh the database and try again.');
      return { ...op, expectRev: row.rev };
    }
    return op;
  });
}

/** View changes as native Pages takes them, for a list of views that belongs to no database (All tasks). */
export function pageViewOps(ops: readonly MichiDbEditOp[]): PageDatabaseEditOp[] {
  return ops.map((op): PageDatabaseEditOp => {
    if (op.op === 'view.save') return nativeViewSave(op.view);
    if (op.op === 'view.delete') return op;
    throw new Error('Only view changes go to a list of views');
  });
}

/** Validate a view for native persistence, including scoped custom components. */
function nativeViewSave(view: MichiDbNewView): PageDatabaseEditOp {
  const source = view.config;
  const supportedConfigKeys = new Set([
    'filters', 'match', 'sorts', 'group', 'visible', 'date', 'planDate', 'cover',
    ...(view.type === 'custom' ? ['componentId', 'pinnedVersion', 'props', 'height'] : []),
  ]);
  const unsupportedConfigKey = Object.keys(source).find((key) => !supportedConfigKeys.has(key));
  if (unsupportedConfigKey) {
    throw new Error(`The ${unsupportedConfigKey} view setting is not supported in native Pages.`);
  }
  const config: PageDatabaseView['config'] = {
    filters: source.filters,
    match: source.match,
    sorts: source.sorts,
    ...(source.group === undefined ? {} : { group: source.group }),
    ...(source.visible === undefined ? {} : { visible: source.visible }),
    ...(source.date === undefined ? {} : { date: source.date }),
    ...(source.planDate === undefined ? {} : { planDate: source.planDate }),
    ...(source.cover === undefined ? {} : { cover: source.cover }),
  };
  if (view.type === 'custom') {
    if (!('componentId' in source) || typeof source.componentId !== 'string' || !source.componentId) {
      throw new Error('A native custom view needs a component ID.');
    }
    config.componentId = source.componentId;
    if ('pinnedVersion' in source && source.pinnedVersion !== undefined) {
      if (typeof source.pinnedVersion !== 'number' || !Number.isSafeInteger(source.pinnedVersion) || source.pinnedVersion < 1) {
        throw new Error('The pinned custom-view version is invalid.');
      }
      config.pinnedVersion = source.pinnedVersion;
    }
    if ('props' in source && source.props !== undefined) {
      if (!source.props || typeof source.props !== 'object' || Array.isArray(source.props)) {
        throw new Error('Custom-view properties must be an object.');
      }
      config.props = source.props as Record<string, unknown>;
    } else config.props = {};
    if ('height' in source && source.height !== undefined) {
      if (typeof source.height !== 'number' || !Number.isFinite(source.height)) throw new Error('Custom-view height must be a number.');
      config.height = source.height;
    }
  }
  const nativeView: PageDatabaseNewView = {
    ...(view.id === undefined ? {} : { id: view.id }),
    name: view.name,
    type: view.type,
    config,
  };
  return { op: 'view.save', view: nativeView };
}
