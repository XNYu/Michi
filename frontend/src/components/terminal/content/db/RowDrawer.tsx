import React, { useEffect, useRef, useState } from 'react';
import type { MichiDatabase, MichiDbColumn, MichiDbEditOp, MichiDbRow } from 'michi-shared';
import { isTaskDb, TASK_COLUMN } from 'michi-shared';
import MarkdownContent, { type MarkdownFeatureProfile } from '../../../MarkdownContent';
import { DrawerShell } from '../../../ui/DrawerShell';
import { openMichiAssistant, type MichiAssistantPage } from '../../../../state/content/assistantBridge';
import { dialogOf, isEditableTarget } from '../threads/threadItem';
import { escapeIsForPage, isInAssistantPanel } from '../../escapeLayers';
import { CellEditor } from './CellEditor';
import { CellView } from './CellView';
import { cellEditable, cellOf, isBlank, titleColumn, type CellValue } from './dbModel';
import { handlesOwnKeys, isEmbeddedDbKey } from './embeddedKeys';
import { columnName, databaseTitle } from './dbLabels';
import { bodyEditOps, cellEditLabel, cellEditOps, deleteRowsOps, rowContextItem } from './dbOps';
import { useLiveThreads } from './liveThreads';
import { TaskConversations } from './TaskConversations';
import { TaskOriginLine, TaskSuggestions, useTaskActivity } from './taskActivity';
import { rowTitle } from './views/RowBits';
import type { DbEdit } from './views/viewTypes';
import '../threads/peek.css';

const BODY_MAX = 20_000;
const THREADS_PAGE: MichiAssistantPage = { kind: 'threads' };
/** Rows are written by people and agents alike: opening one loads nothing, and only https links stay links. */
const ROW_MARKDOWN: MarkdownFeatureProfile = { remoteMedia: false, httpsLinksOnly: true };
const PROSE_CLASS =
  'prose prose-sm max-w-none wrap-break-word [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 '
  + '[&_p]:text-(--term-mid) [&_li]:text-(--term-mid) [&_strong]:text-(--term-fg) [&_a]:text-(--term-accent) [&_code]:text-(--term-fg)';
const PROSE_STYLE: React.CSSProperties = { color: 'var(--term-mid)', fontSize: 'var(--fs-lg)', lineHeight: 1.6 };

/**
 * The side drawer for a row of a database a person made: its title and every
 * property, each edited where it is, then its body as Markdown. ↑/↓ step
 * through the rows in the view's order; Esc closes it before anything else.
 */
export function RowDrawer({
  db,
  rowId,
  order,
  edit,
  notice,
  onOpen,
  onClose,
  keysFirst = null,
  assistantPage = THREADS_PAGE,
  handToAgent,
}: {
  db: MichiDatabase;
  rowId: string | null;
  order: readonly string[];
  edit: DbEdit;
  notice: (text: string) => void;
  onOpen: (rowId: string) => void;
  onClose: () => void;
  /**
   * The drawer of a database on a page: Esc and ↑/↓ pressed in that database
   * (this element) are the drawer's before the page's.
   */
  keysFirst?: React.RefObject<HTMLElement | null> | null;
  /** Where Hand to agent says the row was. */
  assistantPage?: MichiAssistantPage;
  /** Injects the owning surface's assistant route; null hides this action. */
  handToAgent?: ((row: MichiDbRow) => void) | null;
}) {
  const row = rowId ? db.rows.find((r) => r.id === rowId) ?? null : null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const orderRef = useRef(order);
  orderRef.current = order;

  // A row deleted (here or elsewhere) closes its drawer.
  useEffect(() => {
    if (rowId && !row) onClose();
  }, [rowId, row, onClose]);

  useEffect(() => {
    if (!rowId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      // Keys pressed in the ⌘J panel are the panel's (and its menus').
      if (isEditableTarget(event.target) || (event.target instanceof Element && isInAssistantPanel(event.target))) return;
      // Ahead of the page, the arrows are the drawer's only when pressed in the
      // database; Esc closes it from anywhere on the page.
      if (keysFirst && event.key !== 'Escape' && !isEmbeddedDbKey(event, keysFirst.current)) return;
      const dialog = dialogOf(event.target);
      if (dialog && dialog !== dialogOf(bodyRef.current)) return;
      if (event.key === 'Escape') {
        // An open menu over the page takes it, even when its listener runs
        // later; a list or a cell editor in the drawer gives up first.
        if (!escapeIsForPage(event) || handlesOwnKeys(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const list = orderRef.current;
      const at = list.indexOf(rowId);
      const next = at < 0 ? null : list[at + (event.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      onOpen(next);
    };
    const capture = !!keysFirst;
    document.addEventListener('keydown', onKey, capture);
    return () => document.removeEventListener('keydown', onKey, capture);
  }, [rowId, onOpen, onClose, keysFirst]);

  const inOrder = !!rowId && order.includes(rowId);
  return (
    <DrawerShell
      open={row != null}
      onClose={onClose}
      title={isTaskDb(db) ? 'Task' : 'Row'}
      width={440}
      modal={false}
      closeOnEscape={false}
      headerActions={inOrder ? <span className="michi-peek__hint">↑↓ next row</span> : undefined}
    >
      <div ref={bodyRef} className="michi-peek__body">
        {row && <RowBody key={row.id} db={db} row={row} edit={edit} notice={notice} />}
      </div>
      {row && (
        <div className="michi-peek__footer">
          <div className="michi-peek__links">
            {handToAgent !== null && <button
              type="button"
              className="michi-peek__text-btn"
              onClick={() => handToAgent ? handToAgent(row) : openMichiAssistant({ attachments: [rowContextItem(db, row)], page: assistantPage })}
            >
              Hand to agent…
            </button>}
            <button
              type="button"
              className="michi-peek__text-btn"
              onClick={() => {
                onClose();
                void edit(deleteRowsOps([row]), 'Deleted 1 row');
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </DrawerShell>
  );
}

/** One cell set from a drawer: a refused change says why; the undo toast names the one made. */
export function saveRowCell(
  db: MichiDatabase,
  row: MichiDbRow,
  column: MichiDbColumn,
  value: CellValue,
  edit: DbEdit,
  notice: (text: string) => void,
  extra?: MichiDbEditOp[],
): void {
  const check = cellEditOps(db, row, column, value, extra);
  if (!check.ok) notice(check.reason);
  else if (check.ops.length) void edit(check.ops, cellEditLabel(db, column, value));
}

/** A row's notes saved from a drawer, when they changed. */
export function saveRowNotes(row: MichiDbRow, text: string, edit: DbEdit): void {
  const ops = bodyEditOps(row, text);
  if (ops.length) void edit(ops, 'Changed the notes');
}

/** Who a task's status is from: a person (an agent only suggests changes to it then), or an agent reading the conversations. */
function statusOwner(row: MichiDbRow): string {
  if (row.edited?.[TASK_COLUMN.status] !== undefined) return 'Set by you · the agent only suggests changes';
  return isBlank(cellOf(row, TASK_COLUMN.status)) ? '' : 'Set by an agent from the conversations';
}

function RowBody({ db, row, edit, notice }: { db: MichiDatabase; row: MichiDbRow; edit: DbEdit; notice: (text: string) => void }) {
  const title = titleColumn(db);
  const tasks = isTaskDb(db);
  // A task's conversations are a section of their own, under its properties.
  const links = tasks ? db.columns.find((c) => c.id === TASK_COLUMN.threads) : undefined;
  const columns = db.columns.filter((c) => c.id !== title?.id && c !== links);
  const owner = tasks ? statusOwner(row) : '';
  const live = useLiveThreads();
  const workspace = tasks ? live?.workspaceName : undefined;
  const activity = useTaskActivity();
  const suggestions = tasks ? activity?.suggestionsOf?.(row.id) ?? [] : [];
  const seen = activity?.seen;
  // Opening a task's details is seeing what the Meta agent changed on it, also a change that lands while they stay open.
  const mark = tasks ? activity?.markOf?.(row.id) ?? null : null;
  useEffect(() => { if (tasks && mark) seen?.(row.id); }, [tasks, seen, row.id, mark]);
  const save = (column: MichiDbColumn, value: CellValue, extra?: MichiDbEditOp[]) => saveRowCell(db, row, column, value, edit, notice, extra);
  return (
    <>
      <span className="michi-peek__caption michi-db-peek__db">{databaseTitle(db)}</span>
      <h2 className="michi-peek__title">
        {title ? <RowProp db={db} row={row} column={title} heading onSave={(v, extra) => save(title, v, extra)} /> : rowTitle(db, row)}
      </h2>
      {suggestions.length > 0 && activity?.renderSuggestion && (
        <TaskSuggestions db={db} changes={suggestions} render={activity.renderSuggestion} />
      )}
      {(columns.length > 0 || workspace) && (
        <dl className="michi-peek__facts michi-db-peek__props">
          {workspace && (
            <>
              <dt>Workspace</dt>
              <dd><span className="michi-db-peek__value">{workspace}</span></dd>
            </>
          )}
          {columns.map((c) => (
            <React.Fragment key={c.id}>
              <dt>{columnName(db, c)}</dt>
              <dd>
                <RowProp db={db} row={row} column={c} onSave={(v, extra) => save(c, v, extra)} />
                {owner && c.id === TASK_COLUMN.status && <span className="michi-db-peek__owner">{owner}</span>}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {links && <TaskConversations db={db} row={row} column={links} edit={edit} notice={notice} />}
      <RowNotes row={row} onSave={(text) => saveRowNotes(row, text, edit)} />
      {tasks && activity?.loadOrigin && <TaskOriginLine rowId={row.id} load={activity.loadOrigin} />}
    </>
  );
}

/** One property, shown as the views show it; a click (or Enter) on one that can change edits it in place. */
export function RowProp({
  db,
  row,
  column: c,
  heading,
  onSave,
}: {
  db: MichiDatabase;
  row: MichiDbRow;
  column: MichiDbColumn;
  heading?: boolean;
  onSave: (value: CellValue, extra?: MichiDbEditOp[]) => void;
}) {
  const value = cellOf(row, c.id);
  const can = cellEditable(c);
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  if (editing) {
    return (
      <span ref={box} className="michi-db-peek__editing">
        <CellEditor
          db={db}
          column={c}
          row={row}
          value={value}
          anchor={box.current}
          onSave={(v, extra) => { setEditing(false); onSave(v, extra); }}
          onCancel={() => setEditing(false)}
        />
      </span>
    );
  }
  if (c.type === 'checkbox') return <CellView db={db} column={c} value={value} onToggle={can ? (on) => onSave(on) : undefined} />;
  const shown = heading ? rowTitle(db, row) : isBlank(value) ? null : <CellView db={db} column={c} value={value} />;
  if (!can) return <span className="michi-db-peek__value">{shown ?? '—'}</span>;
  return (
    <span
      ref={box}
      className="michi-db-peek__value"
      data-editable="true"
      data-empty={shown === null ? 'true' : undefined}
      role="button"
      tabIndex={0}
      aria-label={`Edit ${columnName(db, c)}`}
      onClick={(event) => {
        // A link inside keeps its own click.
        if (event.target instanceof Element && event.target.closest('a')) return;
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
        if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault();
          setEditing(true);
        }
      }}
    >
      {shown ?? 'Empty'}
    </span>
  );
}

/** The row's own words, as Markdown. Edit opens the source; leaving it saves. */
export function RowNotes({ row, onSave }: { row: MichiDbRow; onSave: (text: string) => void }) {
  const saved = row.body ?? '';
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(saved);
  const dropped = useRef(false);
  useEffect(() => {
    if (!editing) setText(saved);
  }, [saved, editing]);
  return (
    <section className="michi-peek__section" aria-label="Notes">
      <h3 className="michi-peek__caption">
        Notes
        {!editing && (
          <button type="button" className="michi-db-link-btn michi-db-peek__edit" onClick={() => setEditing(true)}>
            {saved ? 'Edit' : 'Write'}
          </button>
        )}
      </h3>
      {editing ? (
        <textarea
          autoFocus
          className="michi-db-input michi-db-peek__body"
          aria-label="Notes"
          placeholder="Markdown"
          maxLength={BODY_MAX}
          rows={8}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          onFocus={() => { dropped.current = false; }}
          onBlur={() => {
            setEditing(false);
            if (!dropped.current) onSave(text);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              dropped.current = true;
              setText(saved);
              setEditing(false);
            }
          }}
        />
      ) : saved ? (
        <MarkdownContent text={saved} size="sm" className={PROSE_CLASS} style={PROSE_STYLE} features={ROW_MARKDOWN} />
      ) : null}
    </section>
  );
}
