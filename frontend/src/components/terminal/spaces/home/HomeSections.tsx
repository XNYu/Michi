import React from 'react';
import { Check, ChevronRight, Clock } from 'lucide-react';
import type { HomeReminderAction, HomeSection, HomeSectionItem, HomeSectionKey } from 'michi-shared';
import { HOME_CONVERSATION_LIST_LIMITS, HOME_SECTION_LIMIT } from 'michi-shared';
import { actOnHomeReminder, fetchHomeConversations } from '../../../../services/api/spacesHome';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';
import { Button } from '../../../ui/controls';
import { MichiTag } from '../../content/MichiTag';
import { ThreadStateDot } from '../../content/ThreadStateDot';
import { michiOneLine } from '../../content/michiPlainText';
import { HOME_SECTION_COPY, homeRowAction, homeRowAge } from './homeFormat';
import { openedSet, useOpenedDoneKey } from './homeCounts';

const NO_ITEMS: readonly HomeSectionItem[] = [];

/** One row: where it lives and how long ago, what it says, and its one action. */
export function HomeSectionRow({ section, item, clock, onAct, onOpenWorkspace, showState = false, onReminder, busy }: {
  /** The section it is listed in; null for a conversation in none (All threads). */
  section: HomeSectionKey | null;
  item: HomeSectionItem;
  clock: number;
  onAct(item: HomeSectionItem, section: HomeSectionKey | null): void;
  /** Set: the workspace name opens that workspace's home. */
  onOpenWorkspace?(workspaceId: string): void;
  /** Leads with the section's state glyph, where rows of different sections share one list. */
  showState?: boolean;
  onReminder?(item: HomeSectionItem, action: HomeReminderAction): void;
  busy?: boolean;
}) {
  const age = homeRowAge(section, item, clock);
  const action = homeRowAction(section, item);
  const workspaceId = item.workspaceId;
  const workspace = item.workspaceName && workspaceId && onOpenWorkspace
    ? <button type="button" className="spaces-home-row__ws" onClick={() => onOpenWorkspace(workspaceId)}>{item.workspaceName}</button>
    : item.workspaceName;
  return (
    <div className="spaces-home-row" data-testid="spaces-home-row" data-kind={item.kind} data-claim={item.agentClaim ? 'true' : undefined}>
      <div className="spaces-home-row__where">
        {showState && section && <ThreadStateDot state={section} />}
        <span>{workspace}{item.workspaceName && item.title ? ' · ' : ''}{item.title}</span>
        {age && <><span aria-hidden="true"> · </span><span className="spaces-home-row__age">{age}</span></>}
        {item.agentClaim && <MichiTag variant="agent-says" />}
      </div>
      {item.summary && <div className="spaces-home-row__what">{michiOneLine(item.summary)}</div>}
      <div className="spaces-home-row__act">
        <Button size="sm" onClick={() => onAct(item, section)} aria-label={`${action}: ${item.title}`}>
          {action}
          {item.target.kind === 'conversation' && <ChevronRight size={12} strokeWidth={1.8} aria-hidden="true" />}
        </Button>
        {/* Secondary reminder actions stay icon-only, shown on row hover, so Continue reads as the row's one action. */}
        {onReminder && item.reminderVersion && <span className="spaces-home-row__more">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onReminder(item, 'snooze')} aria-label={`Remind tomorrow: ${item.title}`} title="Remind tomorrow">
            <Clock size={14} strokeWidth={1.8} aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onReminder(item, 'dismiss')} aria-label={`No longer needs attention: ${item.title}`} title="No longer needs attention">
            <Check size={14} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        </span>}
      </div>
    </div>
  );
}

/**
 * A counted section (Waiting, Stalled or Done): its state glyph, title and
 * total, the note that Michi counts it from your chats, at most
 * HOME_SECTION_LIMIT rows and a way to all of them.
 */
export function HomeSectionBlock({ section, data, clock, onAct, onOpenWorkspace, children, connectionId }: {
  section: HomeSectionKey;
  data: HomeSection | null;
  clock: number;
  onAct(item: HomeSectionItem, section: HomeSectionKey | null): void;
  onOpenWorkspace?(workspaceId: string): void;
  /** Shown after the rows, e.g. the mark of a layout rule that shapes the section. */
  children?: React.ReactNode;
  connectionId?: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [handled, setHandled] = React.useState<{ item: HomeSectionItem; action: HomeReminderAction } | null>(null);
  const act = async (item: HomeSectionItem, action: HomeReminderAction) => {
    if (!connectionId || busy) return;
    setBusy(true); setError(null);
    try {
      await actOnHomeReminder(connectionId, item, action);
      setHandled(action === 'restore' ? null : { item, action });
      notifyPageChanged({ backendConnectionId: connectionId });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update reminder'); }
    finally { setBusy(false); }
  };
  const copy = HOME_SECTION_COPY[section];
  const [expanded, setExpanded] = React.useState(false);
  const [extra, setExtra] = React.useState<{ items: HomeSectionItem[]; loading: boolean; error: string | null }>({ items: [], loading: false, error: null });
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    if (!expanded || !connectionId || !data || data.total <= data.items.length) {
      setExtra({ items: [], loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setExtra({ items: [], loading: true, error: null });
    void fetchHomeConversations(connectionId, { state: section, limit: HOME_CONVERSATION_LIST_LIMITS.max, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setExtra({ items: result.items, loading: false, error: null }); })
      .catch(cause => { if (!controller.signal.aborted) setExtra({ items: [], loading: false, error: cause instanceof Error ? cause.message : 'Could not load conversations' }); });
    return () => controller.abort();
  }, [expanded, connectionId, section, data, retry]);
  const opened = openedSet(useOpenedDoneKey(section === 'done' ? extra.items : NO_ITEMS));
  const known = new Set((data?.items ?? []).map(item => item.id));
  const allItems = [...(data?.items ?? []), ...extra.items.filter(item => !known.has(item.id) && !opened.has(item.id))];
  const items = expanded ? allItems : allItems.slice(0, HOME_SECTION_LIMIT);
  const total = data?.total ?? 0;
  const headingId = `spaces-home-${section}`;
  return (
    <section className="spaces-home-section" aria-labelledby={headingId} data-section={section}>
      <div className="spaces-home-section__head">
        <ThreadStateDot state={section} size="lg" />
        <h2 id={headingId} className="spaces-home-h2">{copy.title}</h2>
        <span className="spaces-home-count">{total}</span>
        <span className="michi-tag spaces-home-tag" data-tone="hint">Counted from your chats</span>
        {(total > Math.min(data?.items.length ?? 0, HOME_SECTION_LIMIT) || allItems.length > HOME_SECTION_LIMIT) && (
          <button type="button" className="michi-home-view-all spaces-home-section__all" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
            {expanded ? 'Show less' : 'View all'} <span className="michi-home-view-all__count">{total}</span>
          </button>
        )}
      </div>
      {data === null && <p className="spaces-home-muted" role="status">Loading…</p>}
      {data !== null && items.length === 0 && <p className="spaces-home-muted">{copy.empty}</p>}
      {items.length > 0 && <div className="spaces-home-rows">
        {items.map((item) => <HomeSectionRow key={item.id} section={section} item={item} clock={clock} onAct={onAct} onOpenWorkspace={onOpenWorkspace} busy={busy} onReminder={connectionId && section !== 'done' ? (item, action) => { void act(item, action); } : undefined} />)}
      </div>}
      {expanded && extra.loading && <p role="status" className="spaces-home-muted">Loading conversations…</p>}
      {expanded && extra.error && <p role="alert">{extra.error}{' '}<Button size="sm" onClick={() => setRetry(value => value + 1)}>Retry</Button></p>}
      {expanded && !extra.loading && !extra.error && total > items.length && <p className="spaces-home-muted">Showing {items.length} of {total}.</p>}
      {error && <p role="alert">{error}</p>}
      {handled && <p role="status" className="spaces-home-muted">
        {handled.action === 'snooze' ? 'Reminder moved to tomorrow.' : 'Reminder removed. New activity can bring it back.'}{' '}
        <Button size="sm" disabled={busy} onClick={() => { void act(handled.item, 'restore'); }}>Undo</Button>
      </p>}
      {children}
    </section>
  );
}
