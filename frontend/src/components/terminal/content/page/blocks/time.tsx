import React, { useState } from 'react';
import type { BlockProps } from '../blockTypes';
import { objects, str, timelineWhen } from '../michiPageModel';
import { ThreadStateDot } from '../../ThreadStateDot';
import { BlockTitle, toneOf } from './text';

/** Milestones a track holds side by side; more read better as a list. */
export const MILESTONE_TRACK_MAX = 6;

type MilestoneState = 'done' | 'next' | 'later';
const MILESTONE_STATE_TEXT: Record<MilestoneState, string> = { done: 'Done', next: 'Next', later: 'Planned' };

/** Each milestone's place: passed, the first one still to come, or after it. */
function milestoneStates(items: Record<string, unknown>[]): MilestoneState[] {
  const next = items.findIndex((it) => it.done !== true);
  return items.map((it, i) => (it.done === true ? 'done' : i === next ? 'next' : 'later'));
}

function When({ at, className }: { at: unknown; className: string }) {
  const when = timelineWhen(at);
  return when.dateTime ? <time className={className} dateTime={when.dateTime}>{when.text}</time> : <span className={className}>{when.text}</span>;
}

/**
 * Milestones in order: a track across the page, each with its date, name and
 * state (its note, else Done, Next or Planned); a narrow pane stacks it. A
 * long run is a dated list instead.
 */
export function MilestonesBlock({ block }: BlockProps) {
  const items = objects(block.items).filter((it) => str(it.label).trim());
  const states = milestoneStates(items);
  return (
    <div data-michi-block="milestones" className="michi-doc-track-host">
      <BlockTitle text={str(block.title)} />
      {items.length <= MILESTONE_TRACK_MAX ? (
        <ol className="michi-doc-track">
          {items.map((it, i) => (
            <li key={i} className="michi-doc-track__item" data-state={states[i]} data-tone={toneOf(it.tone)}>
              <When at={it.date} className="michi-doc-track__when" />
              <span className="michi-doc-track__label">{str(it.label)}</span>
              <span className="michi-doc-track__note">{str(it.note).trim() || MILESTONE_STATE_TEXT[states[i]]}</span>
            </li>
          ))}
        </ol>
      ) : (
        <ul className="michi-doc-dated">
          {items.map((it, i) => (
            <li key={i}>
              <When at={it.date} className="michi-doc-dated__when" />
              <span className="michi-doc-dated__glyph"><ThreadStateDot state={it.done === true ? 'done' : 'doing'} size={10} /></span>
              <span>{str(it.label)}</span>
              {str(it.note).trim() && <span className="michi-doc-dated__text">{str(it.note)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Entries a timeline shows before View all. */
export const TIMELINE_SHOWN = 8;

/** Events in order, each with when it happened and an optional note (a native page's detail). */
export function TimelineBlock({ block }: BlockProps) {
  const items = objects(block.items).filter((it) => str(it.title).trim());
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, TIMELINE_SHOWN);
  const title = str(block.title);
  const more = items.length > TIMELINE_SHOWN;
  return (
    <div data-michi-block="timeline">
      {more ? (
        <div className="michi-doc-block-head">
          {title.trim() ? <BlockTitle text={title} /> : <span />}
          <button type="button" className="michi-doc-link-btn michi-doc-dated__all" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show fewer' : `View all ${items.length}`}
          </button>
        </div>
      ) : <BlockTitle text={title} />}
      <ul className="michi-doc-dated">
        {shown.map((it, i) => {
          const when = timelineWhen(it.at);
          const text = str(it.text).trim() || str(it.detail).trim();
          return (
            <li key={i}>
              {when.dateTime
                ? <time className="michi-doc-dated__when" dateTime={when.dateTime}>{when.text}</time>
                : <span className="michi-doc-dated__when">{when.text}</span>}
              <span className="michi-doc-dated__glyph" aria-hidden="true">
                <span className="michi-doc-dated__dot" data-tone={toneOf(it.tone)} />
              </span>
              <span className="michi-doc-dated__title">{str(it.title)}</span>
              {text && <span className="michi-doc-dated__text">{text}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
