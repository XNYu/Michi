import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { chatLabel, shallowArrayEqual, useStructuralSelector } from '../../state/chatStore';
import type { ProjectEdge } from '../../state/chatTypes';
import { DUR, EASE, TRANSITION } from '../../motion/tokens';
import { isFreshBranch } from './branchMotion';
import { Dot } from './primitives';
import './paneArrivals.css';

const MAX_TABS = 3;
const TAB_ENTER = { duration: DUR.expand, ease: EASE.out };

/**
 * Branches started in the background that opened off screen, oldest first.
 * One leaves the list once it is focused, closed or scrolled into view;
 * `recheck` re-reads the view after the strip scrolls.
 */
export function usePaneArrivals({ scope, panes, focusedPane, edges, enabled, isOnScreen }: {
  scope: string;
  panes: readonly string[];
  focusedPane: string | null;
  edges: readonly ProjectEdge[] | undefined;
  enabled: boolean;
  isOnScreen: (id: string) => boolean;
}) {
  const [arrivals, setArrivals] = useState<string[]>([]);
  const onScreen = useRef(isOnScreen);
  onScreen.current = isOnScreen;
  const previous = useRef({ scope, panes });

  useLayoutEffect(() => {
    const prior = previous.current;
    previous.current = { scope, panes };
    if (!enabled || prior.scope !== scope) {
      setArrivals(current => (current.length ? [] : current));
      return;
    }
    const added = panes.filter(id => !prior.panes.includes(id) && id !== focusedPane
      && isFreshBranch(edges, id) && !onScreen.current(id));
    setArrivals(current => {
      const next = [...current.filter(id => panes.includes(id) && id !== focusedPane), ...added];
      return shallowArrayEqual(next, current) ? current : next;
    });
  }, [scope, panes, focusedPane, edges, enabled]);

  const recheck = useCallback(() => {
    setArrivals(current => {
      const next = current.filter(id => !onScreen.current(id));
      return next.length === current.length ? current : next;
    });
  }, []);

  return { arrivals, recheck };
}

/**
 * One flush list on the strip's right edge, where the new panes are: square,
 * hairline, with a straight accent tick like the sidebar's active row.
 */
export function PaneArrivalTabs({ ids, onOpen }: { ids: readonly string[]; onOpen: (id: string) => void }) {
  // Keep the last rows while the list slides out, so it leaves as it was.
  const lastIds = useRef(ids);
  if (ids.length) lastIds.current = ids;
  const list = ids.length ? ids : lastIds.current;
  const shown = list.slice(0, MAX_TABS);
  const hidden = list.slice(MAX_TABS);
  const titles = useStructuralSelector(nodes => shown.map(id => nodes[id]?.title || chatLabel(nodes[id]) || 'Untitled'), shallowArrayEqual);
  const statuses = useStructuralSelector(nodes => shown.map(id => nodes[id]?.status === 'error' ? 'error'
    : nodes[id]?.status === 'streaming' && !nodes[id]?.visibleResponseComplete ? 'streaming' : 'idle'), shallowArrayEqual);
  return (
    <div className="pane-arrivals" role="group" aria-label="New branches">
      <AnimatePresence initial={false}>
        {ids.length > 0 && (
          <motion.div
            key="list"
            className="pane-arrivals__list"
            inert={ids.length === 0}
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0, transition: TAB_ENTER }}
            exit={{ opacity: 0, x: '100%', transition: TRANSITION.exit }}
          >
            <div className="pane-arrivals__head" aria-hidden>
              <span>{list.length === 1 ? 'New branch' : 'New branches'}</span>
              {list.length > 1 && <span className="pane-arrivals__count">{list.length}</span>}
            </div>
            {shown.map((id, index) => (
              <button key={id} type="button" className="pane-arrival" title={titles[index]} onClick={() => onOpen(id)}>
                <Dot
                  color={statuses[index] === 'error' ? 'var(--term-danger)' : statuses[index] === 'streaming' ? 'var(--term-accent)' : 'var(--term-muted)'}
                  pulse={statuses[index] === 'streaming'}
                />
                <span className="pane-arrival__title">{titles[index]}</span>
                {statuses[index] !== 'idle' && (
                  <span className={`pane-arrival__status${statuses[index] === 'error' ? ' pane-arrival__status--error' : ''}`}>
                    {statuses[index] === 'error' ? 'error' : 'working'}
                  </span>
                )}
              </button>
            ))}
            {hidden.length > 0 && (
              <button
                type="button"
                className="pane-arrival pane-arrival--more"
                aria-label={`${hidden.length} more new branch${hidden.length === 1 ? '' : 'es'}`}
                onClick={() => onOpen(hidden[0])}
              >
                +{hidden.length} more
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
