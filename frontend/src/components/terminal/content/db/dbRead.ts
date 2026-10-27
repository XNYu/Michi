import type {
  MichiDatabase,
  MichiDbColumn,
  MichiDbEditOp,
  MichiDbHead,
  MichiDbRow,
  MichiDbView,
  MichiDbViewConfig,
} from 'michi-shared';
import { byPosition, cellEditable, isThreadsDb, sameValue } from './dbModel';

/** A read answer (DbRead) or the read half of an edit's answer: whichever fields came. */
export interface DbAnswer {
  version?: string;
  database?: MichiDatabase;
  upserts?: MichiDbRow[];
  removed?: string[];
  columns?: MichiDbColumn[];
  views?: MichiDbView[];
  head?: MichiDbHead;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const sameRow = (a: MichiDbRow, b: MichiDbRow) =>
  a.position === b.position && a.updatedAt === b.updatedAt && a.body === b.body && same(a.values, b.values);

function headOf(db: MichiDatabase): MichiDbHead {
  const { columns: _c, views: _v, rows: _r, ...head } = db;
  return head;
}

/** A whole database over the copy: each part equal to the copy's keeps the copy's object, so unchanged cards are not drawn again. */
function share(old: MichiDatabase, next: MichiDatabase): MichiDatabase {
  const had = new Map(old.rows.map((r) => [r.id, r]));
  const rows = next.rows.map((r) => {
    const o = had.get(r.id);
    return o && sameRow(o, r) ? o : r;
  });
  const keptRows = rows.length === old.rows.length && rows.every((r, i) => r === old.rows[i]);
  const columns = same(old.columns, next.columns) ? old.columns : next.columns;
  const views = same(old.views, next.views) ? old.views : next.views;
  if (keptRows && columns === old.columns && views === old.views && same(headOf(old), headOf(next))) return old;
  return { ...headOf(next), columns, views, rows: keptRows ? old.rows : rows };
}

/** Did an answer say anything about the database itself (beyond its version)? */
export function answerHasData(answer: DbAnswer): boolean {
  return !!answer.database || answer.upserts !== undefined || answer.removed !== undefined
    || answer.columns !== undefined || answer.views !== undefined || answer.head !== undefined;
}

/**
 * The copy brought up to date by an answer: a whole database, what changed
 * since the copy's version, or the version alone (nothing changed). The same
 * object when nothing changed. `undefined`: changes for a copy there is none
 * of, which only a whole read can make good.
 */
export function mergeDbAnswer(old: MichiDatabase | null, answer: DbAnswer): MichiDatabase | undefined {
  if (answer.database) return old ? share(old, answer.database) : answer.database;
  if (!old) return undefined;
  const upserts = answer.upserts ?? [];
  const removed = answer.removed ?? [];
  if (!upserts.length && !removed.length && !answer.columns && !answer.views && !answer.head) return old;
  const up = new Map(upserts.map((r) => [r.id, r]));
  const gone = new Set(removed);
  let moved = false;
  let rows = old.rows;
  if (up.size || gone.size) {
    rows = old.rows.flatMap((r) => {
      if (gone.has(r.id)) return [];
      const n = up.get(r.id);
      if (!n) return [r];
      up.delete(r.id);
      if (n.position !== r.position) moved = true;
      return [sameRow(r, n) ? r : n];
    });
    if (up.size) {
      rows.push(...up.values());
      moved = true;
    }
    if (moved) rows.sort(byPosition);
  }
  return {
    ...(answer.head ?? headOf(old)),
    columns: answer.columns && !same(answer.columns, old.columns) ? answer.columns : old.columns,
    views: answer.views && !same(answer.views, old.views) ? answer.views : old.views,
    rows,
  };
}

// ── Drawn ahead of Michi's answer ─────────────────────────────────────

const put = (values: Record<string, unknown>, id: string, v: unknown) => {
  const { [id]: _drop, ...rest } = values;
  return (v === null || v === undefined ? rest : { ...rest, [id]: v }) as MichiDbRow['values'];
};

/** A deleted column leaves nothing behind in a view. */
function unref(c: MichiDbViewConfig, id: string): MichiDbViewConfig {
  const next: MichiDbViewConfig = {
    ...c,
    filters: (c.filters ?? []).filter((f) => f.column !== id),
    sorts: (c.sorts ?? []).filter((s) => s.column !== id),
    ...(c.visible ? { visible: c.visible.filter((x) => x !== id) } : {}),
  };
  for (const k of ['group', 'date', 'planDate', 'cover'] as const) if (next[k] === id) delete next[k];
  return next;
}

/**
 * The database as the ops will leave it, drawn at once while Michi applies
 * them for real. Michi's answer replaces it either way, so this only needs to
 * be right for what a person sees in the moment: values are not converted, and
 * an op this cannot place is left for Michi to decide.
 */
export function applyOpsLocally(db: MichiDatabase, ops: readonly MichiDbEditOp[], now: number): MichiDatabase {
  const threads = isThreadsDb(db);
  let { columns, rows, views } = db;
  const colAt = (id: string) => columns.findIndex((c) => c.id === id);
  const rowAt = (id: string) => rows.findIndex((r) => r.id === id);
  for (const op of ops) {
    switch (op.op) {
      case 'row.update': {
        const i = rowAt(op.id);
        if (i < 0) break;
        let values = rows[i].values;
        for (const [k, v] of Object.entries(op.values ?? {})) {
          const c = columns[colAt(k)];
          if (!c || !cellEditable(c)) continue;
          if (threads && c.builtin && c.id === 'state' && v !== 'doing' && v !== 'done') continue;
          values = put(values, k, v);
        }
        const next: MichiDbRow = { ...rows[i], values, updatedAt: now };
        if (op.body !== undefined) {
          if (op.body) next.body = op.body;
          else delete next.body;
        }
        if (sameValue(next.values as never, rows[i].values as never) && next.body === rows[i].body) break;
        rows = rows.map((r, j) => (j === i ? next : r));
        break;
      }
      case 'row.add': {
        if (threads || !op.id || rowAt(op.id) >= 0) break;
        const position = rows.reduce((m, r) => Math.max(m, r.position + 1), 0);
        const values = Object.fromEntries(Object.entries(op.values).filter(([, v]) => v !== null)) as MichiDbRow['values'];
        rows = [...rows, { id: op.id, values, ...(op.body ? { body: op.body } : {}), position, updatedAt: now }];
        break;
      }
      case 'row.delete':
        if (!threads) rows = rows.filter((r) => r.id !== op.id);
        break;
      case 'column.add': {
        const id = op.column.id;
        if (!id || colAt(id) >= 0) break;
        const column: MichiDbColumn = { ...op.column, id };
        const at = op.after === undefined ? columns.length : op.after === null ? 0 : colAt(op.after) + 1;
        columns = [...columns.slice(0, at), column, ...columns.slice(at)];
        break;
      }
      case 'column.update': {
        const i = colAt(op.id);
        if (i < 0) break;
        const c = columns[i];
        // A built-in column's name, type and options are the thread's; only its width is layout.
        const patch = c.builtin ? (op.patch.width !== undefined ? { width: op.patch.width } : {}) : op.patch;
        columns = columns.map((x, j) => (j === i ? { ...x, ...patch } : x));
        break;
      }
      case 'column.delete': {
        const c = columns[colAt(op.id)];
        if (!c || c.builtin) break;
        columns = columns.filter((x) => x.id !== op.id);
        rows = rows.map((r) => (Object.prototype.hasOwnProperty.call(r.values, op.id) ? { ...r, values: put(r.values, op.id, null) } : r));
        views = views.map((v) => ({ ...v, config: unref(v.config, op.id) }));
        break;
      }
      case 'option.add': {
        const i = colAt(op.id);
        const c = columns[i];
        if (!c || c.builtin || c.options?.some((o) => o.value === op.option.value)) break;
        columns = columns.map((x, j) => (j === i ? { ...x, options: [...(x.options ?? []), op.option] } : x));
        break;
      }
      case 'view.save': {
        const v = op.view;
        const i = v.id === undefined ? -1 : views.findIndex((x) => x.id === v.id);
        if (i >= 0) views = views.map((x, j) => (j === i ? { ...x, name: v.name, type: v.type, config: v.config } : x));
        else if (v.id) views = [...views, { id: v.id, name: v.name, type: v.type, config: v.config, position: views.reduce((m, x) => Math.max(m, x.position + 1), 0) }];
        break;
      }
      case 'view.delete':
        if (views.length > 1) views = views.filter((v) => v.id !== op.id);
        break;
      default:
        break;
    }
  }
  if (columns === db.columns && rows === db.rows && views === db.views) return db;
  return { ...db, columns, rows, views, updatedAt: now };
}
