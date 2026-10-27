import React, { useMemo } from 'react';
import type { MichiDatabase, MichiDbColumn, MichiDbRow, DatabaseRowStatus } from 'michi-shared';
import { ThreadStateDot } from '../../ThreadStateDot';
import { threadItemProps, type ThreadItemHandlers } from '../../threads/threadItem';
import { cellOf, isThreadsDb, shownColumns, titleColumn } from '../dbModel';
import { GroupHeading, groupSums, RowFacts, rowTitle, } from './RowBits';
import type { DbViewProps } from './viewTypes';

/**
 * Rows as a plain list under their group headings, one line each: the state
 * dot (All threads), the title, then the view's other columns as small facts
 * on the right. A new list shows only a few short columns (see
 * `listDefaultColumns`); the title keeps its room and long facts truncate.
 */
export function ListView({ db, view, config, groups, groupColumn, prefs, handlers, threadOf, now }: DbViewProps) {
  const title = titleColumn(db);
  const shown = useMemo(() => shownColumns(db, config, view.type), [db, config, view.type]);
  // All threads' status reads as the dot before the title, not as a fact.
  const dots = isThreadsDb(db) && shown.some((c) => c.id === 'state');
  const facts = useMemo(
    () => shown.filter((c) => c.id !== title?.id && !(isThreadsDb(db) && c.id === 'state')),
    [db, shown, title],
  );
  const grouped = config.group !== undefined && !!groupColumn;
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (!total) return <p className="michi-db-empty">{db.rows.length ? 'Nothing matches these filters' : 'No rows yet'}</p>;
  return (
    <div className="michi-db-list">
      {groups.map((g) => (
        <section key={g.key ?? '\u0000'} className="michi-db-list__group" aria-label={grouped ? g.label || 'Empty' : undefined}>
          {grouped && <GroupHeading db={db} column={groupColumn} group={g} showCount={prefs.showCounts} sums={groupSums(db, g, db.columns, prefs.sums)} />}
          {g.rows.map((row) => (
            <ListRow key={row.id} db={db} row={row} dot={dots} facts={facts} thread={threadOf(row.id)} now={now} handlers={handlers} />
          ))}
        </section>
      ))}
    </div>
  );
}

function ListRow({ db, row, dot, facts, thread, now, handlers }: { db: MichiDatabase; row: MichiDbRow; dot: boolean; facts: MichiDbColumn[]; thread?: DatabaseRowStatus; now: number; handlers: ThreadItemHandlers }) {
  const state = dot ? (cellOf(row, 'state') as DatabaseRowStatus['state'] | null) : null;
  const name = rowTitle(db, row);
  return (
    <div className="michi-db-list__row michi-item" {...threadItemProps(row.id, handlers, 'button')}>
      {dot && (
        <span className="michi-db-list__dot">
          {state && <ThreadStateDot state={state} doneBy={thread?.doneBy} size={8} />}
        </span>
      )}
      <span className="michi-db-list__title" title={name}>{name}</span>
      <RowFacts db={db} row={row} columns={facts} thread={thread} now={now} line />

    </div>
  );
}
