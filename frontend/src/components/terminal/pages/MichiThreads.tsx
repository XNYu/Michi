import React from 'react';
import { X } from 'lucide-react';
import type { HomeConversationItem } from 'michi-shared';
import { useHomeConversations } from '../../../state/pages/useSpacesHome';
import { requestWorkspaceHome } from '../../../state/pages/workspaceHomeNav';
import { clearAllThreadsFilter, type AllThreadsStateFilter } from '../../../state/content/allThreadsFilter';
import { useMinuteClock } from '../content/home/useMinuteClock';
import { HomeSectionRow } from '../spaces/home/HomeSections';
import { HOME_SECTION_COPY } from '../spaces/home/homeFormat';
import { openedSet, useOpenedDoneKey } from '../spaces/home/homeCounts';
import { useHomeNavigation } from '../spaces/home/useHomeNavigation';
import '../content/db/db.css';
import '../spaces/home/home.css';

/** The Spaces Home is the local connection's, so its All threads lists that backend's conversations. */
const CONNECTION = 'local';
const NO_ITEMS: readonly HomeConversationItem[] = [];

/**
 * A Just done row the user has opened since it completed is in no section
 * any more: under the Just done filter it goes, unfiltered it stays without
 * its state.
 */
function withOpened(items: readonly HomeConversationItem[], total: number, opened: ReadonlySet<string>, state: AllThreadsStateFilter | null) {
  if (opened.size === 0) return { items, total };
  if (state === 'done') {
    const kept = items.filter((item) => !opened.has(item.id));
    return { items: kept, total: Math.max(kept.length, total - (items.length - kept.length)) };
  }
  return { items: items.map((item) => (item.state === 'done' && opened.has(item.id) ? { ...item, state: null } : item)), total };
}

/**
 * All threads as Spaces opens it: Michi's own conversations, newest first,
 * each with the Home section it is in. "View all N" opens it narrowed to that
 * section, shown as a filter chip whose × lists every conversation again.
 */
export function MichiThreads({ state }: { state: AllThreadsStateFilter | null }) {
  const clock = useMinuteClock(true);
  const list = useHomeConversations(CONNECTION, state);
  const nav = useHomeNavigation(CONNECTION, null);
  const done = React.useMemo(() => (list.data?.items ?? NO_ITEMS).filter((item) => item.state === 'done'), [list.data]);
  const openedKey = useOpenedDoneKey(done);
  const shown = React.useMemo(
    () => withOpened(list.data?.items ?? NO_ITEMS, list.data?.total ?? 0, openedSet(openedKey), state),
    [list.data, openedKey, state],
  );
  const openWorkspace = React.useCallback((workspaceId: string) => requestWorkspaceHome({ workspaceId, backendConnectionId: CONNECTION }), []);
  const label = state ? `Status is ${HOME_SECTION_COPY[state].title}` : null;

  return (
    <main aria-label="All threads" className="area-settings michi-doc spaces-home spaces-threads">
      <div className="area-settings__doc spaces-home__doc">
        <header className="spaces-home__head">
          <p className="area-settings__kicker">Every chat in Michi</p>
          <div className="spaces-home__title-row">
            <h1 className="spaces-home__title">All threads</h1>
            {list.data && <span className="spaces-home-count" aria-label={`${shown.total} threads`}>{shown.total}</span>}
          </div>
        </header>
        {label && (
          <div className="michi-db-chips" role="group" aria-label="State filter">
            <span className="michi-db-chip">
              {label}
              <button type="button" className="michi-db-chip__x" aria-label={`Remove filter ${label}`} onClick={clearAllThreadsFilter}>
                <X size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
          </div>
        )}
        {list.status === 'error' && !list.data && <p className="spaces-home-muted" role="alert">
          {list.error || 'Conversations could not be loaded.'} <button type="button" className="spaces-home-link" onClick={list.refresh}>Retry</button>
        </p>}
        {!list.data && list.status !== 'error' && <p className="spaces-home-muted" role="status">Loading…</p>}
        {list.data && shown.items.length === 0 && <p className="spaces-home-muted">{state ? HOME_SECTION_COPY[state].empty : 'No conversations yet.'}</p>}
        {shown.items.length > 0 && <section className="spaces-home-section" aria-label="Threads">
          <div className="spaces-home-rows">
            {shown.items.map((item) => (
              <HomeSectionRow key={item.id} section={item.state} item={item} clock={clock} onAct={nav.openSectionItem} onOpenWorkspace={openWorkspace} showState />
            ))}
          </div>
          {shown.total > shown.items.length && <p className="spaces-home-muted spaces-threads__more">
            Showing the {shown.items.length} most recent of {shown.total}.
          </p>}
        </section>}
      </div>
    </main>
  );
}
