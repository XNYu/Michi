import React from 'react';
import type { MichiDatabase, MichiDbRow } from 'michi-shared';
import { ALL_TASKS_COLUMN, taskThreadIds, TASK_COLUMN } from 'michi-shared';
import { formatMichiAge } from '../../michiFormat';
import { michiOneLine } from '../../michiPlainText';
import { optionName } from '../dbLabels';
import { cellOf } from '../dbModel';
import { taskLastActivity, ThreadChips, useLiveThreads } from '../liveThreads';
import { TaskMarks } from '../taskActivity';
import { rowTitle } from './RowBits';

/** The ids of the parts of a task card that are read out with its title (ids that are not drawn are skipped). */
export const taskCardDescribedBy = (titleId: string): string[] => [`${titleId}-marks`, `${titleId}-attention`, `${titleId}-workspace`];

/** A task's card: its title, what is next (until it is done), its conversations, a mark when one waits on you, and when it last moved. */
export function TaskCardBody({ db, row, now, attention, titleId }: { db: MichiDatabase; row: MichiDbRow; now: number; attention: boolean; titleId: string }) {
  const live = useLiveThreads();
  const next = michiOneLine(String(cellOf(row, TASK_COLUMN.next) ?? ''));
  const ids = taskThreadIds(cellOf(row, TASK_COLUMN.threads));
  // On All tasks a card names the workspace its task is in.
  const workspaceColumn = db.merged ? db.columns.find((c) => c.id === ALL_TASKS_COLUMN.workspace) : undefined;
  const workspaceId = cellOf(row, ALL_TASKS_COLUMN.workspace);
  const workspace = workspaceColumn && typeof workspaceId === 'string' && workspaceId ? optionName(db, workspaceColumn, workspaceId) : '';
  return (
    <>
      <span className="michi-card__title"><span id={titleId}>{rowTitle(db, row)}</span><TaskMarks rowId={row.id} id={`${titleId}-marks`} /></span>
      {cellOf(row, TASK_COLUMN.status) !== 'done' && next && <span className="michi-card__next">Next: {next}</span>}
      {ids.length ? <ThreadChips nodeIds={ids} /> : <span className="michi-card__none">No conversations yet</span>}
      <span className="michi-card__foot">
        {attention && <span id={`${titleId}-attention`} className="michi-card__attention">Waiting on you</span>}
        {workspace && <span id={`${titleId}-workspace`} className="michi-card__workspace">{workspace}</span>}
        <span className="michi-threads__spacer" />
        <span className="michi-threads__mono">{formatMichiAge(taskLastActivity(row, live), now)}</span>
      </span>
    </>
  );
}
