import React from 'react';
import type { PageComponentSource, ThreadCardItem } from 'michi-shared';
import { TASK_VIEW } from 'michi-shared';
import NativeDatabase from './NativeDatabase';
import { useTaskDatabase } from './useTaskDatabase';
import './nativeDatabase.css';

export interface NativeTaskViewProps {
  workspaceId: string;
  connectionId: string;
  /** The task database's view it opens on; Board when absent. */
  viewId?: string;
  title?: string;
  compact?: boolean;
  readOnly?: boolean;
  onOpenThread?: (item: ThreadCardItem) => void;
  onNavigatePage?: (pageId: string) => void;
  onOpenSource?: (source: PageComponentSource) => void | boolean | Promise<void | boolean>;
  onAskDraft?: (draft: string) => void;
}

/** A task board: the page's workspace's task database in one of its views, or an offer to make the database. */
export function NativeTaskView({ workspaceId, connectionId, viewId, title, compact = false, readOnly = false, onOpenThread, onNavigatePage, onOpenSource, onAskDraft }: NativeTaskViewProps) {
  const tasks = useTaskDatabase(connectionId, workspaceId);
  const heading = title?.trim() || 'Tasks';
  if (tasks.databaseId) {
    return (
      <NativeDatabase
        databaseId={tasks.databaseId}
        workspaceId={workspaceId}
        connectionId={connectionId}
        viewId={viewId ?? TASK_VIEW.board}
        compact={compact}
        readOnly={readOnly}
        presentation="page"
        heading={heading}
        onOpenThread={onOpenThread}
        onNavigatePage={onNavigatePage}
        onOpenSource={onOpenSource}
        onAskDraft={onAskDraft}
      />
    );
  }
  return (
    <section className="native-task-view" data-native-task-view="" aria-label={heading}>
      <div className="native-db-head"><h2 className="spaces-home-h2">{heading}</h2></div>
      {tasks.databaseId === undefined && !tasks.error ? (
        <p className="michi-doc-unknown" role="status">Reading the task board…</p>
      ) : (
        <div className="native-task-view__empty">
          {tasks.error && <p className="michi-doc-unknown" role="alert">{tasks.error}</p>}
          {tasks.error && tasks.databaseId === undefined && (
            <button type="button" className="michi-db-btn" onClick={tasks.retry}>Retry</button>
          )}
          {tasks.databaseId === null && !tasks.refused && <p className="michi-doc-unknown">This workspace has no task database yet.</p>}
          {tasks.databaseId === null && !readOnly && !tasks.refused && (
            <button type="button" className="michi-db-btn michi-db-btn--primary" disabled={tasks.creating} onClick={() => { void tasks.create(); }}>
              {tasks.creating ? 'Creating…' : 'Create one'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export default NativeTaskView;
