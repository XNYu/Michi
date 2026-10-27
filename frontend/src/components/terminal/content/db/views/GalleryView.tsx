import React, { useMemo } from 'react';
import type { MichiDatabase, MichiDbColumn, MichiDbRow, DatabaseRowStatus } from 'michi-shared';
import { loadableImageUrl } from '../../../../../lib/pictureAddress';
import { ThreadStateDot } from '../../ThreadStateDot';
import { michiOneLine, michiSameText } from '../../michiPlainText';
import { threadItemProps, type ThreadItemHandlers } from '../../threads/threadItem';
import { cellOf, cellText, coverColumn, isBlank, isThreadsDb, rowsInOrder, shownColumns, titleColumn } from '../dbModel';
import { optionName } from '../dbLabels';
import { RowFacts, rowTitle, } from './RowBits';
import type { DbViewProps } from './viewTypes';

/** How much of a row's body a card reads: more than it can show, never a whole long page. */
const BODY_CHARS = 500;

/** The first words a card shows when it has no picture: a thread's next step, else the first text column, else the body. */
export function gallerySnippet(db: MichiDatabase, row: MichiDbRow, title?: MichiDbColumn): string {
  if (isThreadsDb(db)) {
    const next = michiOneLine(String(cellOf(row, 'next') ?? ''));
    const stopped = michiOneLine(String(cellOf(row, 'stoppedAt') ?? ''));
    return next ? `Next: ${next}` : michiSameText(stopped, rowTitle(db, row)) ? '' : stopped;
  }
  const text = db.columns.find((c) => c.type === 'text' && c.id !== title?.id && !isBlank(cellOf(row, c.id)));
  if (text) return cellText(text, cellOf(row, text.id), (c, v) => optionName(db, c, v));
  return michiOneLine((row.body ?? '').slice(0, BODY_CHARS));
}

/** Cards in a grid: the image column (or the view's cover) on top, else the row's first words. */
export function GalleryView({ db, config, groups, handlers, threadOf, now }: DbViewProps) {
  const rows = useMemo(() => rowsInOrder(groups), [groups]);
  const cover = coverColumn(db, config);
  const title = titleColumn(db);
  const facts = useMemo(
    () => shownColumns(db, config).filter((c) => c.id !== title?.id && c.id !== cover?.id && c.type !== 'text' && !(isThreadsDb(db) && c.builtin)),
    [db, config, title, cover],
  );
  if (!rows.length) return <p className="michi-db-empty">{db.rows.length ? 'Nothing matches these filters' : 'No rows yet'}</p>;
  return (
    <div className="michi-db-gallery">
      {rows.map((row) => (
        <GalleryCard key={row.id} db={db} row={row} cover={cover} title={title} facts={facts} thread={threadOf(row.id)} now={now} handlers={handlers} />
      ))}
    </div>
  );
}

function GalleryCard({
  db,
  row,
  cover,
  title,
  facts,
  thread,
  now,
  handlers,
}: {
  db: MichiDatabase;
  row: MichiDbRow;
  cover?: MichiDbColumn;
  title?: MichiDbColumn;
  facts: MichiDbColumn[];
  thread?: DatabaseRowStatus;
  now: number;
  handlers: ThreadItemHandlers;
}) {
  const image = cover ? cellOf(row, cover.id) : null;
  const src = loadableImageUrl(image);
  const state = isThreadsDb(db) ? (cellOf(row, 'state') as DatabaseRowStatus['state'] | null) : null;
  const words = src ? '' : gallerySnippet(db, row, title);
  return (
    <div className="michi-db-gcard michi-card michi-item" {...threadItemProps(row.id, handlers, 'button')}>
      {src ? (
        <img className="michi-db-gcard__cover" src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />
      ) : (
        <span className="michi-db-gcard__words">{words}</span>
      )}
      <span className="michi-card__title">
        {state && <ThreadStateDot state={state} doneBy={thread?.doneBy} size={8} />}
        <span>{rowTitle(db, row)}</span>
      </span>
      <RowFacts db={db} row={row} columns={facts} thread={thread} now={now} />

    </div>
  );
}
