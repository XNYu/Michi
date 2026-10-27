import React from 'react';
import type { BlockProps } from '../blockTypes';
import { list, num, objects, str } from '../michiPageModel';

/** Series take the accent, then mauve, then digest. */
const SERIES_COLORS = ['var(--term-accent)', 'var(--term-mauve)', 'var(--term-digest)'] as const;
const AMOUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

interface Series { key: string; label: string; values: number[]; color: string }

const columns = (count: number) => ({ '--cols': count } as React.CSSProperties);

/**
 * Labels and one value per label for each series: a native chart names its
 * labels; Michi's give each series points, read here in the order their x
 * first appears.
 */
function chartData(block: BlockProps['block']): { labels: string[]; series: Series[] } {
  const raw = objects(block.series).slice(0, SERIES_COLORS.length);
  const named = Array.isArray(block.labels);
  const labels = named ? list(block.labels).map(str) : [...new Set(raw.flatMap((s) => objects(s.points).map((p) => str(p.x))))];
  const series = raw.map((s, i): Series => {
    const at = named ? null : new Map(objects(s.points).map((p) => [str(p.x), num(p.y)]));
    const values = list(s.values);
    return {
      key: `s${i}`,
      label: str(s.label).trim() || `Series ${i + 1}`,
      values: labels.map((label, j) => Math.max(0, (at ? at.get(label) : num(values[j])) ?? 0)),
      color: SERIES_COLORS[i],
    };
  });
  return { labels, series };
}

/**
 * A simple bar or line chart: the legend above, one column per label, the
 * labels underneath. Bars stack when the block says so, the first series at
 * the bottom. The figures behind the drawing are also a table for screen
 * readers, and each bar or point names its figure on hover.
 */
export function ChartBlock({ block }: BlockProps) {
  const title = str(block.title).trim() || 'Chart';
  // Michi's own charts draw more kinds; only bars and lines are drawn here, the rest keep their one line.
  if (block.kind !== 'bar' && block.kind !== 'line' && block.kind !== 'area') {
    return <p className="michi-doc-unknown" data-michi-block="unknown" data-type="chart">{`Chart · ${title}`}</p>;
  }
  const { labels, series } = chartData(block);
  const unit = str(block.unit).trim();
  const line = block.kind !== 'bar';
  const stacked = !line && block.stacked === true;
  const figure = (value: number) => `${AMOUNT.format(value)}${unit ? ` ${unit}` : ''}`;
  const top = Math.max(0, ...labels.map((_, j) => (stacked
    ? series.reduce((sum, s) => sum + s.values[j], 0)
    : Math.max(0, ...series.map((s) => s.values[j]))))) || 1;
  const share = (value: number) => `${(value / top) * 100}%`;
  const tip = (s: Series, j: number) => `${s.label} · ${labels[j]}: ${figure(s.values[j])}`;
  return (
    <figure className="michi-doc-chart" data-michi-block="chart" data-kind={line ? 'line' : 'bar'}>
      <figcaption className="michi-doc-block-head">
        <h3 className="michi-doc-block-title">{title}</h3>
        <span className="michi-doc-chart__legend" aria-hidden="true">
          {series.map((s) => (
            <span key={s.key} className="michi-doc-chart__key"><span className="michi-doc-chart__swatch" style={{ background: s.color }} />{s.label}</span>
          ))}
        </span>
      </figcaption>
      {labels.length > 0 && series.length > 0 && (
        <>
          <div className="michi-doc-chart__plot" style={columns(labels.length)} aria-hidden="true">
            {line ? (
              <>
                <svg className="michi-doc-chart__lines" viewBox="0 0 100 100" preserveAspectRatio="none">
                  {series.map((s) => (
                    <polyline
                      key={s.key}
                      points={s.values.map((v, j) => `${((j + 0.5) / labels.length) * 100},${100 - (v / top) * 100}`).join(' ')}
                      fill="none"
                      stroke={s.color}
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
                {series.flatMap((s) => s.values.map((v, j) => (
                  <span
                    key={`${s.key}:${j}`}
                    className="michi-doc-chart__point"
                    title={tip(s, j)}
                    style={{ left: `${((j + 0.5) / labels.length) * 100}%`, bottom: share(v), background: s.color }}
                  />
                )))}
              </>
            ) : labels.map((label, j) => (
              <div key={j} className="michi-doc-chart__col" data-stacked={stacked || undefined}>
                {/* Stacked, the first series sits at the bottom, so it is drawn last. */}
                {(stacked ? [...series].reverse() : series).map((s) => (
                  <i key={s.key} title={tip(s, j)} data-empty={s.values[j] === 0 || undefined} style={{ height: share(s.values[j]), background: s.color }} />
                ))}
              </div>
            ))}
          </div>
          <div className="michi-doc-chart__x" style={columns(labels.length)} aria-hidden="true">
            {labels.map((label, j) => <span key={j}>{label}</span>)}
          </div>
          <table className="sr-only">
            <caption>{title}</caption>
            <thead><tr><th scope="col">{unit ? `Label (${unit})` : 'Label'}</th>{series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}</tr></thead>
            <tbody>
              {labels.map((label, j) => (
                <tr key={j}><th scope="row">{label}</th>{series.map((s) => <td key={s.key}>{AMOUNT.format(s.values[j])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}
