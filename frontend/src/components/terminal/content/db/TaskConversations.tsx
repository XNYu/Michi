import React, { useRef, useState } from 'react';
import type { MichiDatabase, MichiDbColumn, MichiDbRow, ThreadCardItem } from 'michi-shared';
import { taskThreadIds } from 'michi-shared';
import { ThreadStateDot } from '../ThreadStateDot';
import { formatMichiAge } from '../michiFormat';
import { CellEditor } from './CellEditor';
import { cellOf, type CellValue } from './dbModel';
import { cellEditOps } from './dbOps';
import { liveConversation, threadCardKind, threadNowLine, useLiveThreads } from './liveThreads';
import type { DbEdit } from './views/viewTypes';

/**
 * A task's conversations in its details: each as it stands now, opened with
 * a click; Link picks more from the workspace, and one gone from it can be
 * unlinked.
 */
export function TaskConversations({ db, row, column, edit, notice }: {
  db: MichiDatabase;
  row: MichiDbRow;
  column: MichiDbColumn;
  edit: DbEdit;
  notice: (text: string) => void;
}) {
  const live = useLiveThreads();
  const ids = taskThreadIds(cellOf(row, column.id));
  const [linking, setLinking] = useState(false);
  const linkRef = useRef<HTMLButtonElement>(null);
  const save = (value: CellValue, label: string) => {
    const check = cellEditOps(db, row, column, value);
    if (!check.ok) notice(check.reason);
    else if (check.ops.length) void edit(check.ops, label);
  };
  const unlink = (id: string) => {
    const rest = ids.filter((x) => x !== id);
    save(rest.length ? rest : null, 'Unlinked a conversation');
  };
  return (
    <section className="michi-peek__section michi-db-peek__threads" aria-label="Conversations">
      <h3 className="michi-peek__caption">
        Conversations
        <span className="michi-db-mono michi-db-muted">{ids.length}</span>
        <button ref={linkRef} type="button" className="michi-db-link-btn michi-db-peek__edit" aria-expanded={linking} onClick={() => setLinking(true)}>
          Link
        </button>
      </h3>
      {linking && (
        <span className="michi-db-peek__editing">
          <CellEditor
            db={db}
            column={column}
            row={row}
            value={cellOf(row, column.id)}
            anchor={linkRef.current}
            onSave={(value) => { setLinking(false); save(value, 'Linked conversations'); }}
            onCancel={() => setLinking(false)}
          />
        </span>
      )}
      {ids.length === 0 ? (
        <p className="michi-db-peek__none">No conversations yet</p>
      ) : (
        <ul className="michi-db-peek__thread-list">
          {ids.map((id) => {
            const item = liveConversation(live, id);
            if (item) {
              const line = threadNowLine(item, { runningPrefix: true });
              return (
                <li key={id}>
                  <button type="button" className="michi-db-peek__thread" data-state={item.state} onClick={() => live?.open?.(item)}>
                    <ThreadStateDot kind={threadCardKind(item)} size={10} />
                    <span className="michi-db-peek__thread-title">{item.title}</span>
                    <span className="michi-db-mono michi-db-muted">{formatMichiAge(item.at)}</span>
                    {line && <span className="michi-db-peek__thread-line">{line}</span>}
                  </button>
                </li>
              );
            }
            return (
              <li key={id} className="michi-db-peek__thread" data-missing="true">
                <span aria-hidden="true"><ThreadStateDot kind="idea" size={10} /></span>
                <span className="michi-db-peek__thread-title michi-db-muted">{live?.loaded ? 'This conversation is no longer here' : 'Reading this conversation…'}</span>
                {live?.loaded && <button type="button" className="michi-db-link-btn" onClick={() => unlink(id)}>Unlink</button>}
              </li>
            );
          })}
        </ul>
      )}
      {live?.failed && <p className="michi-db-peek__none" role="status">Couldn't read where these conversations stand just now.</p>}
    </section>
  );
}
