import React from 'react';
import type { MichiDatabase, MichiDbColumn, DatabaseRowStatus } from 'michi-shared';
import { ThreadStateDot } from '../ThreadStateDot';
import { formatMichiAge } from '../michiFormat';
import { michiOneLine } from '../michiPlainText';
import { cellText, isAgentOneLiner, isBlank, isDateValue, isThreadsDb, type CellValue } from './dbModel';
import { loadableImageUrl } from '../../../../lib/pictureAddress';
import { ThreadChips } from './liveThreads';
import { formatDateValue, formatDay, optionName, optionTone } from './dbLabels';

type DbRef = Pick<MichiDatabase, 'id' | 'kind'>;

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });

/** Only a web page becomes a link; any other scheme shows as its words. */
function webUrl(s: string): boolean {
  try {
    const { protocol } = new URL(s);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** One option as a tinted pill. A thread's status draws its state dot. */
export function OptionPill({ db, column, value, thread }: { db: DbRef; column: MichiDbColumn; value: string; thread?: DatabaseRowStatus }) {
  const state = isThreadsDb(db) && column.builtin && column.id === 'state';
  const doneBy = state ? thread?.doneBy : undefined;
  const tone = optionTone(db, column, value);
  return (
    <span
      className="michi-db-pill"
      data-tone={tone ? 'on' : undefined}
      style={tone ? ({ '--pill-tone': tone } as React.CSSProperties) : undefined}
    >
      {state && (
        <span aria-hidden="true" className="michi-db-pill__dot">
          <ThreadStateDot state={value as DatabaseRowStatus['state']} doneBy={doneBy} size={7} />
        </span>
      )}
      {optionName(db, column, value, doneBy)}
    </span>
  );
}

/** An app name as Michi's tag shows it; Michi's own threads get the accent. */
export function AppTag({ name }: { name: string }) {
  return <span className="michi-app-badge michi-db-app" data-michi={name === 'Michi' ? 'true' : undefined} title={name}>{name}</span>;
}

/**
 * A cell as it reads. A value of the wrong type falls back to plain text
 * rather than vanishing. A checkbox is live when `onToggle` is given.
 */
export function CellView({
  db,
  column: c,
  value,
  thread,
  now,
  onToggle,
}: {
  db: DbRef;
  column: MichiDbColumn;
  value: CellValue | undefined;
  thread?: DatabaseRowStatus;
  now?: number;
  onToggle?: (checked: boolean) => void;
}) {
  if (c.type === 'checkbox') {
    return (
      <input
        type="checkbox"
        className="michi-db-check"
        checked={value === true}
        disabled={!onToggle}
        aria-label={c.name}
        onChange={(event) => onToggle?.(event.currentTarget.checked)}
        onClick={(event) => event.stopPropagation()}
      />
    );
  }
  if (isBlank(value)) return null;
  // All threads' last activity reads as an age, like the rest of Michi.
  if (isThreadsDb(db) && c.builtin && c.id === 'lastActivity' && isDateValue(value)) {
    const t = Date.parse(value.start);
    if (!Number.isNaN(t)) {
      const age = formatMichiAge(t, now);
      return <span className="michi-db-mono michi-db-muted">{age === 'now' ? 'now' : `${age} ago`}</span>;
    }
  }
  switch (c.type) {
    case 'select':
      // A thread's status says too when Michi has it archived.
      if (typeof value === 'string' && thread && isThreadsDb(db) && c.builtin && c.id === 'state') {
        return (
          <span className="michi-db-state-cell">
            <OptionPill db={db} column={c} value={value} thread={thread} />
          </span>
        );
      }
      if (typeof value === 'string') return <OptionPill db={db} column={c} value={value} thread={thread} />;
      break;
    case 'app':
      if (typeof value === 'string') return <AppTag name={optionName(db, c, value)} />;
      break;
    case 'multi':
      if (Array.isArray(value)) {
        return <span className="michi-db-pills">{value.map((v) => <OptionPill key={v} db={db} column={c} value={v} />)}</span>;
      }
      break;
    case 'progress':
      if (typeof value === 'number') {
        const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
        return (
          <span className="michi-db-progress" data-full={pct >= 100 ? 'true' : undefined}>
            <span className="michi-db-progress__meter" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
            <span className="michi-db-mono michi-db-muted">{pct}%</span>
          </span>
        );
      }
      break;
    case 'url':
      if (typeof value === 'string' && webUrl(value)) {
        return (
          <a
            className="michi-db-link"
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            title={value}
            onClick={(event) => event.stopPropagation()}
          >
            {domainOf(value)}
          </a>
        );
      }
      break;
    case 'image': {
      const src = loadableImageUrl(value);
      if (src) {
        return (
          <img
            className="michi-db-thumb"
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={(event) => { event.currentTarget.hidden = true; }}
          />
        );
      }
      break;
    }
    case 'date':
      if (isDateValue(value)) return <span className="michi-db-mono">{formatDateValue(value)}</span>;
      if (typeof value === 'string') return <span className="michi-db-mono">{formatDay(value)}</span>;
      break;
    case 'number':
      if (typeof value === 'number') return <span className="michi-db-mono michi-db-num">{NUMBER.format(value)}</span>;
      break;
    case 'threads':
      if (Array.isArray(value)) return <ThreadChips nodeIds={value} />;
      break;
    case 'text':
      if (typeof value === 'string' && isAgentOneLiner(db, c)) return <span className="michi-db-text">{michiOneLine(value)}</span>;
      break;
    default:
      break;
  }
  return <span className="michi-db-text">{cellText(c, value, (col, v) => optionName(db, col, v))}</span>;
}
