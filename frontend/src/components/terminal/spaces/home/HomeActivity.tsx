import React from 'react';
import { MessageSquare, Sparkles } from 'lucide-react';
import type { SpaceActivityDetail, SpaceActivityItem } from 'michi-shared';
import { michiOneLine } from '../../content/michiPlainText';
import { homeAge } from './homeFormat';

export const SPACE_ACTIVITY_SHOWN = 7;

type PageChangeItem = Extract<SpaceActivityItem, { kind: 'page-change' }>;

function activityKey(item: SpaceActivityItem): string {
  return item.kind === 'page-change' ? `change:${item.batchId}` : `thread:${item.threadNodeId}`;
}

function who(by: SpaceActivityDetail['by']): string {
  switch (by.kind) {
    case 'user': return 'You';
    case 'meta-agent': return 'Meta agent';
    case 'conversation': return `“${by.title}”`;
    default: return 'Agent';
  }
}

/** “A”, “A” and “B”, “A”, “B” and “C”; or a count when some changed places have no name. */
function what(detail: SpaceActivityDetail): string {
  const named = detail.names.map((name) => `“${name}”`);
  if (named.length === 0 || named.length < detail.targets) return `${detail.targets} ${detail.targets === 1 ? 'place' : 'places'}`;
  return named.length === 1 ? named[0]! : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

/** "Meta agent rewrote “本周重点”", "预算 ¥9,800 → ¥11,600", "“排查公证失败” updated 2 places, 1 waiting for you". */
export function changeLabel(item: PageChangeItem, detail: SpaceActivityDetail): string {
  const by = who(detail.by);
  const target = what(detail);
  const one = detail.targets === 1;
  const removal = item.ops.length === 1 && item.ops[0] === 'delete';
  let text: string;
  if (detail.value) text = `${detail.value.name ? `${detail.value.name} ` : ''}${detail.value.from} → ${detail.value.to}`;
  else if (detail.action === 'suggested') text = `${by} suggested ${removal ? `removing ${target}` : one ? `a rewrite of ${target}` : `changes to ${target}`}`;
  else if (detail.action === 'accepted') text = `You accepted ${one ? `the rewrite of ${target}` : `the changes to ${target}`}`;
  else if (detail.action === 'dismissed') text = `You dismissed the ${one ? 'suggestion' : 'suggestions'} for ${target}`;
  else if (detail.entries) {
    const { added, removed } = detail.entries;
    text = added > 0
      ? `${by} added ${added} ${added === 1 ? 'entry' : 'entries'} to ${target}`
      : `${by} removed ${removed} ${removed === 1 ? 'entry' : 'entries'} from ${target}`;
  } else text = `${by} ${detail.action} ${target}`;
  if (detail.action !== 'suggested' && item.pending > 0) text += `, ${item.pending} waiting for you`;
  return detail.undone ? `${text} · undone` : text;
}

function activityText(item: SpaceActivityItem): string {
  if (item.kind === 'conversation') return `New conversation “${item.title}”${item.startedFromPageTitle ? ` from ${item.startedFromPageTitle}` : ''}`;
  if (item.detail) return changeLabel(item, item.detail);
  const changed = `${item.actor === 'agent' ? 'Agent' : 'You'} changed ${item.count} ${item.count === 1 ? 'place' : 'places'}`;
  const waiting = item.pending > 0 ? `, ${item.pending} waiting for you` : '';
  // A Markdown hard break (a backslash ending a line, already joined into one line here) is a space, not text.
  const summary = item.summary ? michiOneLine(item.summary.replace(/\\(?:\r?\n|\s+)/g, ' ')) : '';
  return summary ? `${changed}${waiting}: ${summary}` : `${changed}${waiting}`;
}

/**
 * Recent page changes, one row per page and writer, and conversations started
 * from a Space; a row opens what it names. Rows newer than the last look at
 * the Spaces Home, and not the person's own doing, are tinted.
 */
export function SpaceActivityList({ items, clock, onOpen }: {
  items: SpaceActivityItem[] | null;
  clock: number;
  onOpen(item: SpaceActivityItem): void;
}) {
  const shown = (items ?? []).slice(0, SPACE_ACTIVITY_SHOWN);
  return (
    <section className="spaces-home-section" aria-labelledby="spaces-home-activity">
      <div className="spaces-home-section__head">
        <span className="spaces-home-dot" aria-hidden="true" />
        <h2 id="spaces-home-activity" className="spaces-home-h2">Page activity</h2>
        <span className="spaces-home-count">{items?.length ?? 0}</span>
      </div>
      {items === null && <p className="spaces-home-muted" role="status">Loading…</p>}
      {items !== null && shown.length === 0 && <p className="spaces-home-muted">No page changes or new conversations yet.</p>}
      {shown.length > 0 && <div className="spaces-home-feed">
        {shown.map((item) => (
          <button key={activityKey(item)} type="button" className="spaces-home-feed__row" data-fresh={item.fresh || undefined} onClick={() => onOpen(item)}>
            {item.kind === 'conversation'
              ? <MessageSquare size={13} strokeWidth={1.7} aria-hidden="true" />
              : <Sparkles size={13} strokeWidth={1.7} aria-hidden="true" />}
            <span className="spaces-home-feed__text">
              <b>{item.kind === 'conversation' ? item.workspaceName : item.pageTitle}</b>
              <span aria-hidden="true"> · </span>
              {activityText(item)}
              {item.fresh && <span className="sr-only"> (new)</span>}
            </span>
            <span className="spaces-home-feed__age">{homeAge(item.at, clock)}</span>
          </button>
        ))}
      </div>}
    </section>
  );
}
