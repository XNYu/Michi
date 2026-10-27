import React, { useEffect, useState } from 'react';
import type { PageBlockOf, ThreadCardItem } from 'michi-shared';
import { fetchThreadCards } from '../../../services/api/spacesHome';
import { ThreadStateDot } from '../content/ThreadStateDot';
import { threadCardKind, threadNowLine } from '../content/db/liveThreads';
import { formatMichiAge } from '../content/michiFormat';

/** What the cards read of a threads block: its title and the conversations it names. */
type ThreadsBlock = Pick<PageBlockOf<'threads'>, 'title' | 'nodeIds'>;

/** How often a page re-reads its cards while it stays open; focusing the window reads them too. */
const REFRESH_MS = 60_000;

interface CardsState { key: string; items: readonly ThreadCardItem[] | null; failed: boolean }

/** Where each conversation a block names stands now, read from the page's backend; ones gone from the workspace are left out. */
export function useThreadCardItems(connectionId: string, workspaceId: string, nodeIds: readonly string[]): CardsState {
  const ids = nodeIds.join(',');
  const key = `${connectionId}\n${workspaceId}\n${ids}`;
  const [state, setState] = useState<CardsState>({ key, items: null, failed: false });
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const load = () => {
      void fetchThreadCards(connectionId, { workspaceId, nodeIds: ids ? ids.split(',') : [], signal: controller.signal }).then(
        (items) => { if (live) setState({ key, items, failed: false }); },
        () => { if (live) setState((current) => ({ key, items: current.key === key ? current.items : null, failed: true })); },
      );
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener('focus', load);
    return () => {
      live = false;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [connectionId, workspaceId, ids, key]);
  return state.key === key ? state : { key, items: null, failed: false };
}

// One glyph per conversation state, shared with task boards.
export { threadCardKind } from '../content/db/liveThreads';

/**
 * Cards for the conversations a native page names, two to a row, each with
 * where it stands now, what it says and how long ago it moved. A click opens
 * the conversation. One deleted, or moved to another workspace, shows that it
 * is no longer here.
 */
export function NativeThreadCards({ block, items, failed, onOpen, now }: {
  block: ThreadsBlock;
  items: readonly ThreadCardItem[] | null;
  failed?: boolean;
  onOpen(item: ThreadCardItem): void;
  now?: number;
}) {
  const byNode = new Map((items ?? []).map((item) => [item.nodeId, item]));
  const title = block.title?.trim() || 'Threads';
  return (
    <div data-michi-block="threads">
      <h2 className="michi-doc-h2" style={{ marginBottom: 12 }}>
        {title}<span className="michi-doc-h2__count michi-doc-mono">{block.nodeIds.length}</span>
      </h2>
      {items === null ? (
        <p className="michi-doc-unknown" role={failed ? 'alert' : 'status'}>{failed ? 'These conversations could not be read.' : 'Reading these conversations…'}</p>
      ) : (
        <ul className="michi-doc-threads">
          {block.nodeIds.map((nodeId) => {
            const item = byNode.get(nodeId);
            return (
              <li key={nodeId}>
                {item ? (
                  <button type="button" className="michi-doc-thread" data-state={item.state} onClick={() => onOpen(item)} title={item.title}>
                    <ThreadStateDot kind={threadCardKind(item)} size={10} />
                    <span className="michi-doc-thread__title">
                      <span className="michi-doc-thread__title-text">{item.title}</span>
                    </span>
                    <span />
                    <span />
                    <span className="michi-doc-thread__stopped">{threadNowLine(item, { runningPrefix: false })}</span>
                    <span className="michi-doc-thread__age">{formatMichiAge(item.at, now)}</span>
                  </button>
                ) : (
                  <div className="michi-doc-thread" data-missing="true">
                    <span aria-hidden="true"><ThreadStateDot kind="idea" size={10} /></span>
                    <span className="michi-doc-thread__title michi-doc-muted">This conversation is no longer here</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Thread cards that read their conversations from the page's backend, in the page's workspace. */
export function LiveThreadCards({ block, connectionId, workspaceId, onOpen }: {
  block: ThreadsBlock;
  connectionId: string;
  workspaceId: string;
  onOpen(item: ThreadCardItem): void;
}) {
  const state = useThreadCardItems(connectionId, workspaceId, block.nodeIds);
  return <NativeThreadCards block={block} items={state.items} failed={state.failed} onOpen={onOpen} />;
}
