import type { MichiNoticeTone } from '../page/editorTypes';
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { MichiDatabase, MichiDbView, MichiDbViewType, DatabaseRowStatus, MichiThreadState } from 'michi-shared';
import { openMichiAssistant, type MichiAssistantPage } from '../../../../state/content/assistantBridge';
import { EMPTY_SELECTION, applySelectionClick, type ThreadSelection } from '../threads/selection';
import { dialogOf, isEditableTarget, type ThreadItemHandlers } from '../threads/threadItem';
import { escapeIsForPage } from '../../escapeLayers';
import { applyView, dateColumn, effectiveConfig, emptyConfig, isThreadsDb, limitGroups, rowsInOrder, startValues, type DbGroup } from './dbModel';
import { databaseTitle } from './dbLabels';
import { addRowOp, deleteRowsOps, rowContextItem } from './dbOps';
import { pickView, readGroupPrefs, writeGroupPrefs, type GroupPrefs } from './dbPrefs';
import { RowDrawer } from './RowDrawer';
import { isEmbeddedDbKey } from './embeddedKeys';
import { RowsBatchBar, type BatchAction } from './RowsBatchBar';
import { conversationLookup, useLiveThreads } from './liveThreads';
import { ViewTabs } from './ViewTabs';
import { FilterChips, ViewToolbar, type ToolbarPanel } from './ViewToolbar';
import { rowTitle } from './views/RowBits';
import { BoardView } from './views/BoardView';
import { CalendarView } from './views/CalendarView';
import { CustomView } from './views/CustomView';
import { GalleryView } from './views/GalleryView';
import { ListView } from './views/ListView';
import { TableView } from './views/TableView';
import { TimelineView } from './views/TimelineView';
import type { DbEdit, DbViewProps } from './views/viewTypes';
import '../michi.css';
import '../threads/threads.css';
import './db.css';

/** All threads' state columns read left to right as Michi's board always has. */
const STATE_ORDER: readonly MichiThreadState[] = ['waiting', 'doing', 'stalled', 'done', 'idea'];

/** Rows a table, list, gallery or timeline draws before "N more"; a board pages each column itself. */
export const ROWS_PAGE = 300;

const FALLBACK_VIEW: MichiDbView = { id: 'table', name: 'Table', type: 'table', config: emptyConfig(), position: 0 };
const THREADS_PAGE: MichiAssistantPage = { kind: 'threads' };

/** Host services for database feedback, clipboard and assistant actions.
 * Omitted capabilities remain unavailable. */
export interface DatabaseViewServices {
  notice?: (text: string, tone?: MichiNoticeTone) => void;
  copyText?: (text: string) => Promise<void>;
  handToAgent?: (items: Array<{ id: string; title: string }>, page: MichiAssistantPage) => void;
}

function plural(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** Views that draw the (paged) groups as they come; a board and a calendar say what they draw themselves. */
const DRAWS_GROUPS: ReadonlySet<MichiDbView['type']> = new Set(['table', 'list', 'gallery', 'timeline']);

/** Groups as a view draws them: All threads' states in Michi's order (Chatted only shown on request), empty ones hidden when asked. */
export function shapeGroups(db: MichiDatabase, groups: DbGroup[], groupBy: string | undefined, prefs: GroupPrefs, showChattedOnly: boolean): DbGroup[] {
  let out = groups;
  if (isThreadsDb(db) && groupBy === 'state') {
    const rank = (g: DbGroup) => (g.key === null ? STATE_ORDER.length : Math.max(0, STATE_ORDER.indexOf(g.key as MichiThreadState)));
    out = out.slice().sort((a, b) => rank(a) - rank(b));
    if (!showChattedOnly) out = out.filter((g) => g.key !== 'idea');
  }
  if (groupBy !== undefined && prefs.hideEmpty) out = out.filter((g) => g.rows.length > 0);
  return out;
}

/**
 * One database with its views: the saved-view tabs, the toolbar (Properties ·
 * Filter · Sort · Group · count · New), the filter chips, the view itself, the batch
 * bar for picked rows and the row drawer. All threads' rows are threads:
 * they open the thread peek and keep its ↑/↓ order; rows of a database a
 * person made open the row drawer. `embedded`: drawn inside a page block,
 * where the page has keys of its own: it names no crumb, its Esc (picked
 * rows, the row drawer) comes before the page's for keys pressed in it, and
 * the assistant hears of it as part of that page (`assistantPage`).
 */
export function DatabaseView({
  db,
  edit,
  viewId,
  onViewChange,
  threadOf,
  now,
  embedded = false,
  assistantPage = THREADS_PAGE,
  services,
  renderCustomView,
  onAddCustomView,
  drawAs,
}: {
  db: MichiDatabase;
  edit: DbEdit;
  viewId: string | null;
  onViewChange: (viewId: string) => void;
  embedded?: boolean;
  /** Where Hand to agent says the rows were (All threads, unless shown on a project's page). */
  assistantPage?: MichiAssistantPage;
  /** Services supplied by the native Page host. */
  services?: DatabaseViewServices;
  /** Native Pages can supply a workspace-scoped sandbox renderer. */
  renderCustomView?: (view: MichiDbView) => React.ReactNode;
  /** Offers Custom… when adding a view; the caller has a custom view built. */
  onAddCustomView?: () => void;
  /**
   * What to draw a view as where it has less room than its own layout needs
   * (a board beside the chat draws as a table). Only the drawing changes:
   * every save keeps the view's own type.
   */
  drawAs?: (view: MichiDbView) => MichiDbViewType;
  threadOf: (rowId: string) => DatabaseRowStatus | undefined;
  now: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Refused edits say why as plain information; the copy below says how it went.
  const notice = useCallback((text: string, tone: MichiNoticeTone = 'info') => {
    services?.notice?.(text, tone);
  }, [services]);
  const view = pickView(db.views, viewId) ?? FALLBACK_VIEW;
  const drawn = drawAs?.(view) ?? view.type;
  const config = useMemo(() => effectiveConfig(db, view), [db, view]);
  const [panel, setPanel] = useState<ToolbarPanel | null>(null);

  // How groups read is kept per view on this machine; `prefsSeq` re-reads it after a change.
  const [prefsSeq, setPrefsSeq] = useState(0);
  const prefs = useMemo(
    () => readGroupPrefs(db.id, view.id, view.type),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db.id, view.id, view.type, prefsSeq],
  );
  const setPrefs = (next: GroupPrefs) => {
    writeGroupPrefs(db.id, view.id, next);
    setPrefsSeq((n) => n + 1);
  };

  const rows = db.rows;
  const groupColumn = config.group !== undefined ? db.columns.find((c) => c.id === config.group) : undefined;
  // A filter on a Conversations column reads where its conversations stand now (Needs you).
  const live = useLiveThreads();
  const conversation = useMemo(() => conversationLookup(live), [live]);
  const groups = useMemo(
    () => shapeGroups(db, applyView({ id: db.id, kind: db.kind, columns: db.columns, rows }, config, { conversation }), groupColumn?.id, prefs, true),
    [db, rows, config, groupColumn, prefs, conversation],
  );
  const shownRows = useMemo(() => rowsInOrder(groups), [groups]);

  const [paging, setPaging] = useState({ view: view.id, limit: ROWS_PAGE });
  const limit = paging.view === view.id ? paging.limit : ROWS_PAGE;
  const paged = useMemo(
    () => (drawn === 'board' || drawn === 'calendar' ? { groups, rest: 0 } : limitGroups(groups, limit)),
    [drawn, groups, limit],
  );

  // The rows the view draws, in its reading order: the peek's ↑/↓ and Shift-click ranges go by these.
  const [reported, setReported] = useState<{ view: string; ids: string[] }>({ view: '', ids: [] });
  const onDrawn = useCallback((ids: string[]) => {
    setReported((prev) => (prev.view === view.id && sameIds(prev.ids, ids) ? prev : { view: view.id, ids }));
  }, [view.id]);
  const draws = DRAWS_GROUPS.has(drawn) && (drawn !== 'timeline' || !!dateColumn(db, config));
  const order = useMemo(() => {
    if (draws) return rowsInOrder(paged.groups).map((r) => r.id);
    return reported.view === view.id ? reported.ids : [];
  }, [draws, paged.groups, reported, view.id]);
  const orderRef = useRef(order);
  orderRef.current = order;
  // Receipts and source links address native rows by ID. The shared row
  // renderers already expose data-thread-id for both table rows and board
  // cards; mirror it under a resource-neutral attribute at this seam.
  useLayoutEffect(() => {
    if (!services || !rootRef.current) return;
    rootRef.current.querySelectorAll<HTMLElement>('[data-thread-id]').forEach((element) => {
      element.dataset.rowId = element.dataset.threadId;
    });
  }, [db.rows, order, services, view.id]);

  const [rowPeek, setRowPeek] = useState<string | null>(null);
  const peekId = rowPeek;
  const onItemOpen = useCallback((id: string) => setRowPeek(id), []);
  const closeRowPeek = useCallback(() => setRowPeek(null), []);

  const [selection, setSelection] = useState<ThreadSelection>(EMPTY_SELECTION);
  // Rows gone after a read (archived, deleted elsewhere) leave the selection.
  useEffect(() => {
    setSelection((prev) => {
      if (prev.selected.size === 0) return prev;
      const present = new Set(rows.map((r) => r.id));
      const kept = Array.from(prev.selected).filter((id) => present.has(id));
      if (kept.length === prev.selected.size) return prev;
      return { selected: new Set(kept), anchor: prev.anchor && present.has(prev.anchor) ? prev.anchor : null };
    });
  }, [rows]);

  const onItemToggle = useCallback((id: string) => {
    setSelection((prev) => applySelectionClick(prev, id, { toggle: true, range: false }, orderRef.current));
  }, []);
  const onItemClick = useCallback((id: string, event: React.MouseEvent) => {
    const toggle = event.metaKey || event.ctrlKey;
    if (toggle || event.shiftKey) {
      event.preventDefault();
      setSelection((prev) => applySelectionClick(prev, id, { toggle, range: !toggle }, orderRef.current));
      return;
    }
    onItemOpen(id);
  }, [onItemOpen]);
  const handlers = useMemo<ThreadItemHandlers>(() => ({
    peekId,
    selected: selection.selected,
    onItemClick,
    onItemOpen,
    onItemToggle,
  }), [peekId, selection.selected, onItemClick, onItemOpen, onItemToggle]);

  const selectedRows = useMemo(() => shownRows.filter((r) => selection.selected.has(r.id)), [shownRows, selection.selected]);
  const clearSelection = useCallback(() => setSelection(EMPTY_SELECTION), []);
  const hasSelection = selectedRows.length > 0;
  const peekOpen = peekId != null;

  // Esc clears the selection before the shell sees it (the shell's Esc leaves the page). An open drawer takes Esc first;
  // Esc inside any other dialog belongs to that dialog.
  useEffect(() => {
    if (!hasSelection || peekOpen) return;
    const onKey = (event: KeyboardEvent) => {
      // Not one pressed in the ⌘J panel, taken already, or meant for an open menu.
      if (!escapeIsForPage(event)) return;
      if (isEditableTarget(event.target) || dialogOf(event.target)) return;
      if (embedded && !isEmbeddedDbKey(event, rootRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
    };
    // On a page, ahead of the page's own Esc (its block selection, then leaving the page).
    document.addEventListener('keydown', onKey, embedded);
    return () => document.removeEventListener('keydown', onKey, embedded);
  }, [hasSelection, peekOpen, clearSelection, embedded]);

  const handToAgent: BatchAction | null = services ? (services.handToAgent ? {
    label: 'Hand to agent…',
    onClick: () => services.handToAgent?.(selectedRows.map((r) => ({ id: r.id, title: rowTitle(db, r) })), assistantPage),
  } : null) : {
    label: 'Hand to agent…',
    onClick: () => {
      openMichiAssistant({ attachments: selectedRows.map((r) => rowContextItem(db, r)), page: assistantPage });
    },
  };
  const after: BatchAction[] = [
    { label: 'Delete', danger: true, onClick: () => { void edit(deleteRowsOps(selectedRows), `Deleted ${plural(selectedRows.length, 'row')}`); clearSelection(); } },
    ...(handToAgent ? [handToAgent] : []),
  ];

  const addRow = () => {
    const { id, op } = addRowOp(startValues(db, config));
    void edit([op], 'Added a row');
    setRowPeek(id);
  };

  const uid = useId();
  const tabId = (id: string) => `${uid}-tab-${id}`;
  const panelId = `${uid}-panel`;

  const props: DbViewProps = { db, view, config, groups: paged.groups, groupColumn, prefs, edit, handlers, threadOf, now, notice, onDrawn };
  let body: React.ReactNode;
  switch (drawn) {
    case 'board': body = <BoardView {...props} />; break;
    case 'table': body = <TableView {...props} onFilterPanel={() => setPanel('filter')} />; break;
    case 'timeline': body = <TimelineView {...props} />; break;
    case 'calendar': body = <CalendarView key={`${db.id}\n${view.id}`} {...props} />; break;
    case 'gallery': body = <GalleryView {...props} />; break;
    case 'list': body = <ListView {...props} />; break;
    case 'custom': body = renderCustomView?.(view) ?? <CustomView />; break;
    default: body = <CustomView />;
  }

  return (
    <div ref={rootRef} className="michi-db" data-kind={db.kind} data-embedded={embedded || undefined}>
      <div className="michi-db__bar">
        {db.views.length > 0 ? (
          <ViewTabs db={db} view={view} edit={edit} onSelect={onViewChange} panelId={panelId} tabId={tabId} onAddCustomView={onAddCustomView} />
        ) : (
          <span className="michi-db__title">{databaseTitle(db)}</span>
        )}
        <span className="michi-threads__spacer" />
        <ViewToolbar
          db={db}
          view={view}
          config={config}
          edit={edit}
          prefs={prefs}
          onPrefs={setPrefs}
          count={shownRows.length}
          openPanel={panel}
          onPanel={setPanel}
        />
        {/* All tasks adds no task: a task is added on its workspace's own board. */}
        {!db.merged && (
          <button type="button" className="michi-db-btn michi-db-btn--primary michi-db__new" onClick={addRow}>
            <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
            New
          </button>
        )}
      </div>
      <FilterChips db={db} view={view} edit={edit} />
      <div id={panelId} className="michi-threads__body michi-db__body" role="tabpanel" aria-labelledby={db.views.length ? tabId(view.id) : undefined} aria-label={db.views.length ? undefined : databaseTitle(db)}>
        {body}
        {paged.rest > 0 && (
          <button type="button" className="michi-board__more michi-db-more" onClick={() => setPaging({ view: view.id, limit: limit + ROWS_PAGE })}>
            {Math.min(ROWS_PAGE, paged.rest)} more
          </button>
        )}
      </div>

      {/* Always mounted, so screen readers hear each change of the count; a
          live region rather than role="status", which would sit empty here. */}
      <span className="michi-threads__sr" aria-live="polite" aria-atomic="true">{hasSelection ? `${selectedRows.length} selected` : ''}</span>
      {hasSelection && (
        <RowsBatchBar
          db={db}
          rows={selectedRows}
          unit="row"
          group={groupColumn}
          edit={edit}
          notice={notice}
          after={after}
          onClear={clearSelection}
        />
      )}
      <RowDrawer
        db={db}
        rowId={rowPeek}
        order={order}
        edit={edit}
        notice={notice}
        onOpen={setRowPeek}
        onClose={closeRowPeek}
        keysFirst={embedded ? rootRef : null}
        assistantPage={assistantPage}
        handToAgent={services ? (services.handToAgent ? (row) => services.handToAgent?.([{ id: row.id, title: rowTitle(db, row) }], assistantPage) : null) : undefined}
      />
    </div>
  );
}
