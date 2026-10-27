import React from 'react';
import type { BlockProps } from '../blockTypes';
import { cellText, httpsUrl, isObj, list, num, objects, str } from '../michiPageModel';
import { ThreadStateDot, type MichiDotKind } from '../../ThreadStateDot';
import { BlockTitle } from './text';

function Table({ title, head, rows, label }: {
  title: string;
  head: string[];
  rows: Array<Array<{ content: React.ReactNode; type?: string }>>;
  label: string;
}) {
  return (
    <>
      <BlockTitle text={title} />
      <div className="michi-doc-table-wrap">
        <table className="michi-doc-table" aria-label={title || label}>
          <thead>
            <tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => <td key={c} data-type={cell.type}>{cell.content}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** A plain table from an older page: text columns and rows, padded or cut to the header. */
export function TableBlock({ block }: BlockProps) {
  const head = list(block.columns).map(str);
  const rows = list(block.rows).filter(Array.isArray).map((r) => head.map((_, i) => ({ content: str((r as unknown[])[i]) })));
  return (
    <div data-michi-block="table">
      <Table title={str(block.title)} head={head} rows={rows} label="Table" />
    </div>
  );
}

interface Column {
  id: string;
  name: string;
  type: string;
  labels: Map<string, string>;
}

function columnsOf(v: unknown): Column[] {
  return objects(v).map((c, i) => {
    const labels = new Map<string, string>();
    for (const o of list(c.options)) {
      if (typeof o === 'string') labels.set(o, o);
      else if (isObj(o) && str(o.value)) labels.set(str(o.value), str(o.label).trim() || str(o.value));
    }
    return { id: str(c.id) || `c${i}`, name: str(c.name).trim() || `Column ${i + 1}`, type: str(c.type) || 'text', labels };
  });
}

function cell(column: Column, value: unknown): React.ReactNode {
  if (value == null) return '';
  switch (column.type) {
    case 'checkbox':
      return value === true ? <span aria-label="Yes">✓</span> : '';
    case 'select':
      return column.labels.get(str(value)) ?? str(value);
    case 'multi':
      return list(value).map((v) => column.labels.get(str(v)) ?? str(v)).filter(Boolean).join(', ');
    case 'progress': {
      const n = num(value);
      if (n == null) return '';
      return `${Math.round(n <= 1 ? n * 100 : n)}%`;
    }
    case 'url':
    case 'image': {
      const href = httpsUrl(value);
      return href ? <a href={href} target="_blank" rel="noopener noreferrer">{str(value)}</a> : str(value);
    }
    default:
      return cellText(value);
  }
}

/** A typed table: its columns and rows as the database holds them, shown read-only. */
export function DatabaseBlock({ block }: BlockProps) {
  const columns = columnsOf(block.columns);
  const rows = objects(block.rows).map((r) => {
    const values = isObj(r.values) ? r.values : {};
    return columns.map((c) => ({
      content: cell(c, Object.prototype.hasOwnProperty.call(values, c.id) ? values[c.id] : null),
      type: c.type,
    }));
  });
  return (
    <div data-michi-block="database">
      <Table title={str(block.title)} head={columns.map((c) => c.name)} rows={rows} label="Table" />
    </div>
  );
}

/** Each criterion state as the status glyph draws it and in words. */
const CRITERION: Record<string, { kind: MichiDotKind; words: string }> = {
  done: { kind: 'done', words: 'done' },
  'in-progress': { kind: 'doing', words: 'in progress' },
  stalled: { kind: 'stalled', words: 'stalled' },
  'not-started': { kind: 'idea', words: 'not started' },
};

/**
 * Success criteria: each one, where it stands now (its state glyph and the
 * figure, or the state in words when there is no figure) and where that
 * figure comes from.
 */
export function CriteriaBlock({ block }: BlockProps) {
  const items = objects(block.items).filter((it) => str(it.text).trim());
  const title = str(block.title).trim() || 'Success criteria';
  return (
    <div data-michi-block="criteria">
      <BlockTitle text={title} />
      <div className="michi-doc-table-wrap">
        <table className="michi-doc-table michi-doc-criteria" aria-label={title}>
          <thead>
            <tr><th scope="col">Criterion</th><th scope="col">Now</th><th scope="col">From</th></tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const state = CRITERION[str(it.state)] ?? CRITERION['not-started'];
              const now = str(it.now).trim();
              return (
                <tr key={i}>
                  <td>{str(it.text)}</td>
                  <td>
                    <span className="michi-doc-criteria__now" data-state={str(it.state) || undefined}>
                      <span aria-hidden="true"><ThreadStateDot kind={state.kind} size={10} /></span>
                      {now ? <><span className="sr-only">{state.words}: </span><span className="michi-doc-mono">{now}</span></> : state.words}
                    </span>
                  </td>
                  <td className="michi-doc-criteria__from">{str(it.from)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
