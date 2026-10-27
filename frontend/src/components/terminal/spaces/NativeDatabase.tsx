import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { MichiDbEditOp, MichiDbView, MichiDbViewType, PageChangeDto, PageComponentSource, ThreadCardItem } from 'michi-shared';
import { isTaskDb, taskThreadIds, TASK_COLUMN } from 'michi-shared';
import { CustomDatabaseView } from './components/CustomDatabaseView';
import { changePageChange, revertPageBatch } from '../../../services/api/pages';
import { fetchTaskOrigin } from '../../../services/api/taskDatabase';
import { useOptionalChatProjects } from '../../../state/chatStore';
import { openExactSourcePopover } from '../../../state/sourceNav/sourceNav';
import { notifyPageChanged } from '../../../state/pages/pageEvents';
import { usePageDatabase } from '../../../state/pages/usePageDatabase';
import { DatabaseView } from '../content/db/DatabaseView';
import { LiveThreadsContext, type LiveThreads } from '../content/db/liveThreads';
import { TaskActivityContext, TaskUpkeepLine, type TaskActivityView } from '../content/db/taskActivity';
import { pageDatabaseForMichiView, pageDatabaseOps } from '../content/db/nativeDatabaseAdapter';
import { VIEW_TYPE_LABEL } from '../content/db/dbLabels';
import { pickView } from '../content/db/dbPrefs';
import type { DbEditOptions } from '../content/db/views/viewTypes';
import { ChangeCard, type AcceptedPageEdit } from './ChangeCard';
import { workspaceConversations } from './taskConversations';
import { useTaskUpkeep } from './useTaskUpkeep';
import { useThreadStates } from './useThreadStates';
import './nativeDatabase.css';

export interface NativeDatabaseProps {
  databaseId: string;
  workspaceId: string;
  connectionId: string;
  viewId?: string;
  compact?: boolean;
  readOnly?: boolean;
  /**
   * `page`: a block of a Space page. The database's title and view kind head
   * the block and the view shows bare; its bar and row controls appear while
   * the pointer or focus is in it.
   */
  presentation?: 'full' | 'page';
  /** A task board's own title, in place of the database's. */
  heading?: string;
  onAskDraft?: (draft: string) => void;
  onNavigatePage?: (pageId: string) => void;
  onOpenSource?: (source: PageComponentSource) => void | boolean | Promise<void | boolean>;
  /** Opens a conversation a task links (its pill on a card, or its row in the task's details). */
  onOpenThread?: (item: ThreadCardItem) => void;
}

/** In its narrow form (beside the chat) a board draws as a table, and the head says so; it stays a board. */
const narrowForm = (view: MichiDbView): MichiDbViewType => (view.type === 'board' ? 'table' : view.type);

/** What Custom… puts in the assistant's box: the start of a request the person finishes. */
const customViewDraft = (title: string) => `Make a custom view of the “${title.trim() || 'Untitled'}” database that shows `;

const conversationCount = (n: number) => `${n} conversation${n === 1 ? '' : 's'}`;

/** Native Pages adapter around Michi's database views (table, board, list,
 * calendar, gallery, timeline, and custom views the assistant builds).
 * Reads and writes stay on the Pages API and keep its revision metadata. A
 * task database also reads where its linked conversations stand, for its
 * cells, cards, filters and details. */
export function NativeDatabase({ databaseId, workspaceId, connectionId, viewId, compact = false, readOnly: ownerReadOnly = false, presentation = 'full', heading, onAskDraft, onNavigatePage, onOpenSource, onOpenThread }: NativeDatabaseProps) {
  const { database, status, error, stale, refresh, edit } = usePageDatabase({
    backendConnectionId: connectionId,
    workspaceId,
    databaseId,
  });
  const [selectedView, setSelectedView] = useState<string | null>(viewId ?? null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [failedDraft, setFailedDraft] = useState<{ ops: MichiDbEditOp[]; label: string } | null>(null);
  useEffect(() => { setSelectedView(viewId ?? null); }, [databaseId, viewId]);
  const displayDb = useMemo(() => database ? pageDatabaseForMichiView(database) : null, [database]);

  const tasks = !!database && isTaskDb(database);
  const linked = useMemo(
    () => (tasks && database ? database.rows.flatMap((row) => taskThreadIds(row.values[TASK_COLUMN.threads])) : []),
    [tasks, database],
  );
  const threadStates = useThreadStates(connectionId, linked, tasks);
  // The host's opener changes every render; the board reads it when a pill is clicked.
  const openThreadRef = useRef(onOpenThread);
  openThreadRef.current = onOpenThread;
  const canOpenThread = !!onOpenThread;
  const loadConversations = useCallback(() => workspaceConversations(connectionId, workspaceId), [connectionId, workspaceId]);
  const workspaceName = useOptionalChatProjects()?.projects.find((project) => project.id === workspaceId)?.name;
  const live = useMemo<LiveThreads | null>(() => (tasks ? {
    ...threadStates,
    workspaceId,
    ...(workspaceName ? { workspaceName } : {}),
    loadConversations,
    ...(canOpenThread ? { open: (item: ThreadCardItem) => openThreadRef.current?.(item) } : {}),
  } : null), [tasks, threadStates, workspaceId, workspaceName, loadConversations, canOpenThread]);

  // Undo of a card moved on a board: the batch its edit made, put back.
  const undo = useCallback(async (batchId: string) => {
    try {
      const { conflicts } = await revertPageBatch(batchId, { backendConnectionId: connectionId, workspaceId });
      if (conflicts.length) toast.error('Not undone: it changed again since. Move it back yourself.');
    } catch {
      toast.error("Couldn't undo that just now.");
    }
    refresh();
    notifyPageChanged({ backendConnectionId: connectionId, workspaceId, databaseId });
  }, [connectionId, databaseId, refresh, workspaceId]);

  const saveRef = useRef<((ops: MichiDbEditOp[], label: string, options?: DbEditOptions, undoing?: boolean) => Promise<boolean>) | null>(null);
  // `undoing`: this write is an Undo's inverse; if it cannot be applied (its anchor row is gone), say so rather than keep a draft whose Retry can never work.
  const save = useCallback(async (ops: MichiDbEditOp[], label: string, options?: DbEditOptions, undoing = false): Promise<boolean> => {
    if (!database || ownerReadOnly || status !== 'ready' || stale || ops.length === 0) return false;
    setWriteError(null);
    try {
      const answer = await edit(pageDatabaseOps(ops, database));
      setFailedDraft(null);
      const batchId = answer?.changes?.applied?.[0]?.batchId;
      if (options?.undo && batchId) {
        // A reorder is undone by moving the card back as a new edit: reverting the batch would fight the renumbered neighbours.
        const back = options.undoOps;
        toast(label, { action: { label: 'Undo', onClick: () => { if (back) void saveRef.current?.(back, 'Moved it back', undefined, true); else void undo(batchId); } } });
      }
      return true;
    } catch (cause) {
      if (undoing) {
        toast.error("Couldn't undo the move.");
        refresh();
        return false;
      }
      // Changed meanwhile (here, in another pane, by the assistant): the read that follows shows where it stands.
      const conflict = (cause as { status?: number })?.status === 409;
      setWriteError(conflict ? 'This database just changed, so it was refreshed. Try again.' : cause instanceof Error ? cause.message : "Couldn't save this database");
      setFailedDraft({ ops, label });
      refresh();
      return false;
    }
  }, [database, edit, ownerReadOnly, refresh, stale, status, undo]);
  saveRef.current = save;

  // The Meta agent's upkeep of a task board: its marks, its suggestions, and its latest update with Undo.
  const upkeep = useTaskUpkeep({ connectionId, workspaceId, databaseId, revision: database?.revision ?? null, enabled: tasks });
  const refreshUpkeep = upkeep.refresh;
  const [undoing, setUndoing] = useState(false);
  const afterChange = useCallback(() => {
    refresh();
    refreshUpkeep();
    notifyPageChanged({ backendConnectionId: connectionId, workspaceId, databaseId });
  }, [connectionId, databaseId, refresh, refreshUpkeep, workspaceId]);
  const undoUpkeep = useCallback(async (batchId: string) => {
    setUndoing(true);
    try {
      const { conflicts } = await revertPageBatch(batchId, { backendConnectionId: connectionId, workspaceId });
      if (conflicts.length) toast.error('Not all of it was undone: some tasks changed again since.');
      else toast("Undid the Meta agent's update");
    } catch {
      toast.error("Couldn't undo that just now.");
    }
    setUndoing(false);
    afterChange();
  }, [afterChange, connectionId, workspaceId]);
  const decide = useCallback(async (change: PageChangeDto, action: 'accept' | 'dismiss', edited?: AcceptedPageEdit) => {
    setWriteError(null);
    try {
      await changePageChange(change.id, action, { backendConnectionId: connectionId, workspaceId }, edited ? { editedContent: edited } : undefined);
    } catch (cause) {
      setWriteError(cause instanceof Error ? cause.message : "Couldn't save that just now.");
    }
    afterChange();
  }, [afterChange, connectionId, workspaceId]);
  const openSource = useCallback((source: { nodeId: string; turnId?: string; assistantId: string }) => {
    openExactSourcePopover({ backendConnectionId: connectionId }, source);
  }, [connectionId]);
  const loadOrigin = useCallback((rowId: string) => fetchTaskOrigin({ backendConnectionId: connectionId, workspaceId, databaseId, rowId }),
    [connectionId, databaseId, workspaceId]);
  const { markOf, suggestionsOf, seen } = upkeep;
  const activity = useMemo<TaskActivityView | null>(() => (tasks ? {
    markOf, suggestionsOf, seen, loadOrigin,
    renderSuggestion: (change: PageChangeDto) => (
      <ChangeCard
        change={change}
        variant="inline"
        onAccept={(item, edited) => decide(item, 'accept', edited)}
        onDismiss={(item) => decide(item, 'dismiss')}
        onReopen={() => {}}
        onRevert={() => {}}
        onRedo={() => {}}
        onOpenSource={openSource}
      />
    ),
  } : null), [tasks, markOf, suggestionsOf, seen, loadOrigin, decide, openSource]);

  if (!database || !displayDb) {
    if (status === 'error') return <div data-native-database="" data-database-id={databaseId}><p className="michi-doc-unknown" role="alert">{error ?? "Couldn't load this database"}</p></div>;
    return <div data-native-database="" data-database-id={databaseId}><p className="michi-doc-unknown" role="status">Reading the database…</p></div>;
  }

  const isReadOnly = ownerReadOnly || status !== 'ready' || stale;
  const asPage = presentation === 'page';
  const title = heading ?? (database.title.trim() || 'Untitled database');
  const head = (type: keyof typeof VIEW_TYPE_LABEL | undefined) => asPage ? (
    <div className="native-db-head">
      <h2 className="spaces-home-h2">{title}</h2>
      {tasks && <span className="native-db-head__count michi-doc-mono">{database.rows.length}</span>}
      <span className="michi-tag native-db-head__tag">{tasks ? 'Tasks' : 'Database'} · {VIEW_TYPE_LABEL[type ?? 'table']} view</span>
    </div>
  ) : null;
  if (isReadOnly) {
    return (
      <section className="michi-db" aria-label={database.title} data-native-database="" data-database-id={databaseId} data-read-only="" data-presentation={asPage ? 'page' : undefined}>
        {head('table')}
        <p className="michi-doc-unknown" role="status">{ownerReadOnly ? 'This database is read-only because its workspace or page is archived.' : error ?? 'This database is out of date. Refresh before editing.'}</p>
        {!ownerReadOnly && <button type="button" className="michi-db-btn" onClick={refresh}>Refresh</button>}
        {failedDraft && (
          <div className="michi-doc-unknown" role="group" aria-label="Unsent database edit">
            <span>{failedDraft.label} remains as an unsaved draft while this database reloads.</span>
            <button type="button" className="michi-db-btn" onClick={() => setFailedDraft(null)}>Discard draft</button>
          </div>
        )}
        <div className="michi-db-table" role="region" aria-label={`${database.title} read-only rows`}>
          <table className="michi-db-grid">
            <thead><tr>{database.columns.map((column) => <th key={column.id} scope="col">{column.name}</th>)}</tr></thead>
            <tbody>{database.rows.map((row) => (
              <tr key={row.id} data-row-id={row.id}>{database.columns.map((column) => {
                const value = row.values[column.id];
                const text = Array.isArray(value)
                  ? (column.type === 'threads' ? conversationCount(value.length) : value.join(', '))
                  : value == null ? '' : typeof value === 'object' ? value.start : String(value);
                return <td key={column.id}>{text}</td>;
              })}</tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    );
  }

  const activeView = pickView(displayDb.views, selectedView ?? viewId ?? null);
  const shownType = activeView && compact ? narrowForm(activeView) : activeView?.type;

  const body = (
    <div data-native-database="" data-database-id={databaseId} data-compact={compact || undefined} data-presentation={asPage ? 'page' : undefined} data-tasks={tasks || undefined}>
      {head(shownType)}
      {writeError && <p className="michi-doc-unknown" role="alert">{writeError}</p>}
      {failedDraft && (
        <div className="michi-doc-unknown" role="group" aria-label="Unsent database edit">
          <span>{failedDraft.label} is still an unsaved draft.</span>
          <button type="button" className="michi-db-btn" onClick={() => { void save(failedDraft.ops, failedDraft.label); }}>Retry saving draft</button>
          <button type="button" className="michi-db-btn" onClick={() => setFailedDraft(null)}>Discard draft</button>
        </div>
      )}
      {tasks && !displayDb.rows.length && (
        <p className="native-db-hint">No tasks yet. Ask the assistant to gather this workspace's tasks from its conversations, or add one to a column.</p>
      )}
      {tasks && threadStates.failed && <p className="native-db-hint" role="status">Couldn't read where the linked conversations stand just now.</p>}
      {tasks && upkeep.activity?.latestUpkeep && (
        <TaskUpkeepLine
          upkeep={upkeep.activity.latestUpkeep}
          now={Date.now()}
          undoing={undoing}
          onUndo={() => { void undoUpkeep(upkeep.activity!.latestUpkeep!.batchId); }}
          onOpenSource={openSource}
        />
      )}
      <DatabaseView
        db={displayDb}
        edit={save}
        viewId={selectedView ?? viewId ?? null}
        onViewChange={setSelectedView}
        threadOf={() => undefined}
        now={Date.now()}
        services={{
          notice: (message) => setWriteError(message),
          copyText: (text) => navigator.clipboard.writeText(text),
        }}
        onAddCustomView={onAskDraft ? () => onAskDraft(customViewDraft(database.title)) : undefined}
        drawAs={compact ? narrowForm : undefined}
        renderCustomView={(view) => {
          const nativeView = database.views.find((candidate) => candidate.id === view.id);
          if (!nativeView || nativeView.type !== 'custom' || !nativeView.config.componentId) return null;
          return <CustomDatabaseView
            key={`${database.id}:${nativeView.id}`}
            database={database}
            view={{
              ...nativeView,
              config: {
                ...nativeView.config,
                props: nativeView.config.props ?? {},
              },
            }}
            workspaceId={workspaceId}
            connectionId={connectionId}
            readOnly={isReadOnly}
            onAskDraft={onAskDraft}
            onNavigatePage={onNavigatePage}
            onOpenSource={onOpenSource}
          />;
        }}
      />
    </div>
  );
  if (!live) return body;
  return (
    <TaskActivityContext.Provider value={activity}>
      <LiveThreadsContext.Provider value={live}>{body}</LiveThreadsContext.Provider>
    </TaskActivityContext.Provider>
  );
}

export default NativeDatabase;
