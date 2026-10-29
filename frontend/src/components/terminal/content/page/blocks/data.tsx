import React, { useEffect, useId, useState } from 'react';
import type { BlockProps } from '../blockTypes';
import { isPlanSchedule, list, num, objects, pct, planActualModel, planScheduleModel, str, timelineWhen } from '../michiPageModel';
import { MessageSquare } from 'lucide-react';
import { CheckIcon } from '../../../icons';
import { Button } from '../../../../ui/controls';
import { useBlockSend } from '../vendor-blocks/src/desk/blocks/catalog/interactive/useBlockSend';
import type { PageBlockWithSources } from '../vendor-blocks/shared/desk-blocks';
import { BlockTitle } from './text';
import { PageViewEntry } from '../PageViewContext';

/** A row of labelled figures; tone `warn` flags one, `accent` highlights it. A note is a native page's hint. */
export function MetricsBlock({ block }: BlockProps) {
  const items = objects(block.items).filter((m) => str(m.label).trim() || str(m.value).trim());
  return (
    <dl className="michi-doc-metrics" data-layout={items.every((m) => str(m.value).length <= 12) ? 'row' : 'cards'} data-michi-block="metrics">
      {items.map((m, i) => {
        const hint = str(m.hint).trim() || str(m.note).trim();
        return (
          <div key={i} className="michi-doc-metric" data-tone={m.tone === 'warn' || m.tone === 'accent' ? m.tone : undefined}>
            <dt className="michi-doc-caption">{str(m.label)}</dt>
            <dd className="michi-doc-metric__value">{m.action ? <PageViewEntry action={m.action}><span className="sr-only">{str(m.label)}: </span>{str(m.value)}</PageViewEntry> : str(m.value)}</dd>
            {hint && <dd className="michi-doc-metric__hint">{hint}</dd>}
          </div>
        );
      })}
    </dl>
  );
}

const ARROWS = { up: '↑', down: '↓', flat: '→' } as const;
type Direction = keyof typeof ARROWS;

function directionOf(delta: string, tone: unknown): Direction {
  if (tone === 'up' || tone === 'down' || tone === 'flat') return tone;
  if (/^\s*\+/.test(delta)) return 'up';
  if (/^\s*[-−–]/.test(delta)) return 'down';
  return 'flat';
}

function Spark({ values }: { values: number[] }) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - lo) / span) * 24 - 2}`)
    .join(' ');
  return (
    <svg className="michi-doc-stat__spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** One big figure with an optional change and trend line. */
export function StatBlock({ block }: BlockProps) {
  const delta = str(block.delta).trim();
  const dir = delta ? directionOf(delta, block.deltaTone) : 'flat';
  const spark = list(block.spark).map(num).filter((n): n is number => n != null);
  return (
    <div className="michi-doc-metric" data-michi-block="stat" style={{ maxWidth: 280 }}>
      <span className="michi-doc-caption">{str(block.label)}</span>
      <span className="michi-doc-metric__value" style={{ fontSize: 'var(--fs-5xl)' }}>{str(block.value)}</span>
      {delta && <span className="michi-doc-stat__delta" data-dir={dir}><span aria-hidden="true">{ARROWS[dir]}</span> {delta}</span>}
      {spark.length >= 2 && <Spark values={spark} />}
    </div>
  );
}

/** Share done, with a tick where the plan expected it by now. */
export function ProgressBlock({ block }: BlockProps) {
  const actual = Math.min(1, Math.max(0, num(block.actual) ?? 0));
  const rawExpected = num(block.expected);
  const expected = rawExpected == null ? null : Math.min(1, Math.max(0, rawExpected));
  const words = `actual ${pct(actual)}${expected == null ? '' : ` · plan by now ${pct(expected)}`}`;
  return (
    <div data-michi-block="progress">
      <BlockTitle text={str(block.title)} />
      <div
        className="michi-doc-progress"
        role="progressbar"
        aria-label={str(block.title) || 'Progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(actual * 100)}
        aria-valuetext={words}
      >
        <span className="michi-doc-progress__fill" style={{ width: pct(actual) }} />
        {expected != null && <span className="michi-doc-progress__mark" style={{ left: pct(expected) }} />}
      </div>
      <div className="michi-doc-progress__legend" aria-hidden="true">{words}</div>
    </div>
  );
}

const share = (f: number) => `${(f * 100).toFixed(2)}%`;

/**
 * Plan against actual per item: the plan as an outline, the actual filled
 * (any overrun in the warning colour), a dashed forecast when there is one,
 * and a line for today when the block places it. `actual / planned` sits on
 * the right in words, so nothing depends on the bars alone.
 */
export function PlanActualBlock({ block, ctx }: BlockProps) {
  if (isPlanSchedule(block)) return <PlanScheduleBlock block={block} ctx={ctx} />;
  const model = planActualModel(block);
  const title = str(block.title).trim();
  return (
    <div data-michi-block="plan-actual">
      <div className="michi-doc-block-head">
        <h3 className="michi-doc-block-title">{title || 'Plan vs actual'}</h3>
        <span className="michi-doc-pa__legend" aria-hidden="true">
          <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="plan" />plan</span>
          <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="actual" />actual</span>
          {model.hasOver && <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="over" />over plan</span>}
          {model.hasForecast && <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="forecast" />forecast</span>}
        </span>
      </div>
      <ul className="michi-doc-pa__grid">
        {model.rows.map((row, i) => (
          <li
            key={i}
            className="michi-doc-pa__row"
            data-over={row.over || undefined}
            aria-label={`${row.label}: ${row.text}${row.over ? ', over plan' : ''}`}
          >
            <span className="michi-doc-pa__label">{row.label}</span>
            <span className="michi-doc-pa__track" aria-hidden="true">
              {row.planWidth > 0 && <span className="michi-doc-pa__bar" data-kind="plan" style={{ left: 0, width: share(row.planWidth) }} />}
              {row.actualWidth > 0 && <span className="michi-doc-pa__bar" data-kind="actual" style={{ left: 0, width: share(row.actualWidth) }} />}
              {row.overWidth > 0 && <span className="michi-doc-pa__bar" data-kind="over" style={{ left: share(row.overStart), width: share(row.overWidth) }} />}
              {row.forecastWidth > 0 && (
                <span className="michi-doc-pa__bar" data-kind="forecast" style={{ left: share(row.forecastStart), width: share(row.forecastWidth) }} />
              )}
              {model.today != null && <span className="michi-doc-pa__today" style={{ left: share(model.today) }} />}
            </span>
            <span className="michi-doc-pa__nums">{row.text}</span>
          </li>
        ))}
        {model.today != null && (
          <li className="michi-doc-pa__row" aria-hidden="true">
            <span />
            <span className="michi-doc-pa__axis"><span style={{ left: share(model.today) }}>today</span></span>
            <span />
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * A plan-actual block in days: one calendar track for every phase, the plan
 * as an outline over what happened, today as a line and the dates under it.
 * Days taken against days planned sit on the right in words.
 */
function PlanScheduleBlock({ block, ctx }: BlockProps) {
  const model = planScheduleModel(block, ctx.now ?? Date.now());
  const title = str(block.title).trim();
  const place = (span: { start: number; width: number }) => ({ left: share(span.start), width: share(span.width) });
  return (
    <div data-michi-block="plan-actual" data-measure="days">
      <div className="michi-doc-block-head">
        <h3 className="michi-doc-block-title">{title || 'Plan vs actual'}</h3>
        <span className="michi-doc-pa__legend" aria-hidden="true">
          <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="plan" />plan</span>
          <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="actual" />actual</span>
          {model.hasOver && <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="over" />over plan</span>}
          {model.hasForecast && <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="forecast" />forecast</span>}
        </span>
      </div>
      <ul className="michi-doc-pa__grid">
        {model.rows.map((row, i) => (
          <li key={i} className="michi-doc-pa__row" data-over={row.overPlan || undefined} aria-label={row.words}>
            <span className="michi-doc-pa__label">{row.label}</span>
            <span className="michi-doc-pa__track" aria-hidden="true">
              <span className="michi-doc-pa__bar" data-kind="plan" style={place(row.plan)} />
              {row.actual && <span className="michi-doc-pa__bar" data-kind="actual" style={place(row.actual)} />}
              {row.over && <span className="michi-doc-pa__bar" data-kind="over" style={place(row.over)} />}
              {row.forecast && <span className="michi-doc-pa__bar" data-kind="forecast" style={place(row.forecast)} />}
              {model.today != null && <span className="michi-doc-pa__today" style={{ left: share(model.today) }} />}
            </span>
            <span className="michi-doc-pa__nums">{row.text}</span>
          </li>
        ))}
        {model.axis.length > 0 && (
          <li className="michi-doc-pa__row" aria-hidden="true">
            <span />
            <span className="michi-doc-pa__axis">
              {model.axis.map((label) => <span key={label.kind} data-kind={label.kind} style={{ left: share(label.at) }}>{label.text}</span>)}
            </span>
            <span />
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * Options side by side, each with its value, note, pros and cons. On a page
 * the person may edit, "Pick this" records their choice on the block; the
 * agent's leaning shows until they pick. Elsewhere the button is off.
 */
export function CompareBlock({ block, ctx }: BlockProps) {
  const options = objects(block.options);
  const picked = typeof block.picked === 'number' && options[block.picked] ? block.picked : null;
  const pick = ctx.updateBlock && typeof block.id === 'string' && block.id ? ctx.updateBlock : undefined;
  return (
    <div data-michi-block="compare">
      <BlockTitle text={str(block.title)} />
      <ul className="michi-doc-compare">
        {options.map((o, i) => {
          const name = str(o.name).trim();
          if (!name) return null;
          const lean = o.lean === true && picked === null;
          const chosen = picked === i;
          const pros = list(o.pros).map(str).filter((line) => line.trim());
          const cons = list(o.cons).map(str).filter((line) => line.trim());
          const value = str(o.value).trim();
          const unit = str(o.unit).trim();
          return (
            <li key={i} className="michi-doc-option" data-lean={lean || undefined} data-picked={chosen || undefined}>
              <span className="michi-doc-option__head">
                <span className="michi-doc-option__name">{name}</span>
                {chosen && <span className="michi-doc-option__tag">Picked</span>}
                {lean && <span className="michi-doc-caption michi-doc-caption--accent">Leaning</span>}
              </span>
              {value && <span className="michi-doc-option__value">{value}{unit && <small> {unit}</small>}</span>}
              {str(o.note).trim() && <span className="michi-doc-option__note">{str(o.note)}</span>}
              {(pros.length > 0 || cons.length > 0) && (
                <ul className="michi-doc-option__lines">
                  {pros.map((line, j) => <li key={`p${j}`} data-kind="pro"><span className="sr-only">Pro: </span>{line}</li>)}
                  {cons.map((line, j) => <li key={`c${j}`} data-kind="con"><span className="sr-only">Con: </span>{line}</li>)}
                </ul>
              )}
              <button
                type="button"
                className="michi-doc-option__pick"
                disabled={!pick || chosen}
                aria-pressed={pick ? chosen : undefined}
                title={pick ? undefined : 'Coming later'}
                onClick={() => pick?.(block, { ...block, picked: i })}
              >
                {chosen ? 'Picked' : 'Pick this'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Conversations that disagree, as a choice to make: each version with the
 * app or conversation it came from (which opens it) and when. "Keep this"
 * records the version kept, "Both are fine" that both stand; once decided the
 * kept version is marked and the choice can be changed.
 */
export function ConflictBlock({ block, ctx }: BlockProps) {
  const options = objects(block.options);
  const resolution = block.resolution === 'both' ? 'both' : typeof block.resolution === 'number' && options[block.resolution] ? block.resolution : null;
  const decide = ctx.updateBlock && typeof block.id === 'string' && block.id ? ctx.updateBlock : undefined;
  const [choosing, setChoosing] = useState(false);
  const keptIndex = typeof resolution === 'number' ? resolution : null;
  const [selected, setSelected] = useState<number | null>(keptIndex);
  // When the versions or the decision change under it (an agent rewrote the block), the choice starts again from what is kept.
  const versions = options.map((o) => str(o.text)).join('\n');
  useEffect(() => { setSelected(keptIndex); setChoosing(false); }, [versions, keptIndex, resolution]);
  const name = useId();
  const open = resolution === null || choosing;
  const question = str(block.question).trim();
  const save = (next: number | 'both') => {
    setChoosing(false);
    decide?.(block, { ...block, resolution: next });
  };
  return (
    <fieldset className="michi-doc-conflict" data-michi-block="conflict" data-resolved={open ? undefined : 'true'}>
      <legend className="michi-doc-conflict__q">{question || 'Which is right?'}</legend>
      {options.map((o, i) => {
        const text = str(o.text).trim();
        if (!text) return null;
        const kept = !open && (resolution === 'both' || resolution === i);
        const from = str(o.from).trim();
        const nodeId = str(o.nodeId).trim();
        const when = o.at === undefined ? null : timelineWhen(o.at);
        const where = from && nodeId && ctx.openConversation
          ? <button type="button" className="michi-doc-conflict__from" onClick={() => ctx.openConversation?.(nodeId)} aria-label={`Open the conversation in ${from}`}>{from}</button>
          : from ? <span className="michi-doc-conflict__from">{from}</span> : null;
        return (
          <label key={i} className="michi-doc-conflict__option" data-on={(open ? selected === i : kept) || undefined} data-muted={!open && !kept ? 'true' : undefined}>
            <input
              type="radio"
              name={name}
              checked={open ? selected === i : kept}
              disabled={!decide || !open}
              onChange={() => setSelected(i)}
            />
            <span className="michi-doc-conflict__text">{text}</span>
            <span className="michi-doc-conflict__meta">
              {where}
              {when && (when.dateTime ? <time dateTime={when.dateTime}>{when.text}</time> : <span>{when.text}</span>)}
              {kept && <span className="michi-doc-option__tag">{resolution === 'both' ? 'Both stand' : 'Kept'}</span>}
            </span>
          </label>
        );
      })}
      {decide && (open ? (
        <div className="michi-doc-conflict__actions">
          <Button size="sm" variant="primary" disabled={selected === null || !options[selected]} onClick={() => { if (selected !== null && options[selected]) save(selected); }}>Keep this</Button>
          <Button size="sm" variant="ghost" onClick={() => save('both')}>Both are fine</Button>
          {choosing && <Button size="sm" variant="ghost" onClick={() => { setChoosing(false); setSelected(keptIndex); }}>Cancel</Button>}
        </div>
      ) : (
        <div className="michi-doc-conflict__actions">
          <button type="button" className="michi-doc-link-btn" onClick={() => { setSelected(keptIndex); setChoosing(true); }}>Change</button>
        </div>
      ))}
    </fieldset>
  );
}

/** Choosing sends only the question and answer the person can see. */
export function ChoiceBlock({ block, ctx }: BlockProps) {
  const question = str(block.question).trim();
  const options = list(block.options).map(str).filter((option) => option.trim());
  const { available, locked, fire } = useBlockSend(block as PageBlockWithSources, ctx);
  const [picked, setPicked] = useState<number | null>(null);
  const selected = (ctx.updateBlock ? null : picked) ?? (typeof block.selected === 'number' ? block.selected : -1);
  return <fieldset className="michi-doc-choice" data-michi-block="choice" disabled={!available || locked}>
    <legend className="michi-doc-choice__q">{question}</legend>
    {options.map((option, index) => <button type="button" key={index} className="michi-doc-choice__option" aria-pressed={selected === index}
      onClick={() => { if (fire(`For “${question}” I pick: ${option}`, question)) { if (ctx.updateBlock) ctx.updateBlock(block, { ...block, selected: index }); else setPicked(index); } }}>
      <span className="michi-doc-radio" aria-hidden="true" /><span>{option}</span>
    </button>)}
  </fieldset>;
}

export function ProsConsBlock({ block }: BlockProps) {
  const pros = list(block.pros).map(str).filter((s) => s.trim());
  const cons = list(block.cons).map(str).filter((s) => s.trim());
  const title = str(block.title).trim();
  // Under the block's own title the sides are subheads; without one they are its headings.
  const SideHead = title ? 'h4' : 'h3';
  const side = (kind: 'pro' | 'con', head: string, items: string[]) => items.length > 0 && (
    <div>
      <SideHead className="michi-doc-caption">{head}</SideHead>
      <ul>
        {items.map((t, i) => (
          <li key={i}><span className="michi-doc-pc__mark" data-kind={kind} aria-hidden="true">{kind === 'pro' ? '✓' : '✗'}</span>{t}</li>
        ))}
      </ul>
    </div>
  );
  return (
    <div data-michi-block="pros-cons">
      <BlockTitle text={title} />
      <div className="michi-doc-pc">
        {side('pro', 'Pros', pros)}
        {side('con', 'Cons', cons)}
      </div>
    </div>
  );
}

/**
 * Items with their marks; done ones are struck through. On a page the person
 * may edit, a mark ticks the item there and then.
 */
export function ChecklistBlock({ block, ctx }: BlockProps) {
  const all = objects(block.items);
  const items = all.map((it, index) => ({ it, index })).filter(({ it }) => str(it.text).trim());
  const done = items.filter(({ it }) => it.done === true).length;
  const toggle = ctx.toggleItem && typeof block.id === 'string' && block.id ? ctx.toggleItem : undefined;
  return (
    <div data-michi-block="checklist">
      <div className="michi-doc-block-head">
        <h3 className="michi-doc-block-title">{str(block.title).trim() || 'Checklist'}</h3>
        <span className="michi-doc-mono michi-doc-muted" style={{ fontSize: 'var(--fs-sm)' }}>{done}/{items.length}</span>
      </div>
      <ul className="michi-doc-checklist">
        {items.map(({ it, index }) => {
          const checked = it.done === true;
          return (
            <li key={index} data-done={checked || undefined}>
              {toggle ? (
                <button
                  type="button"
                  className="michi-doc-check michi-doc-check--live"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={str(it.text)}
                  onClick={() => toggle(block, index)}
                >
                  {checked && <CheckIcon size={10} />}
                </button>
              ) : (
                <span className="michi-doc-check" role="checkbox" aria-checked={checked} aria-readonly="true" aria-label={str(it.text)}>
                  {checked && <CheckIcon size={10} />}
                </span>
              )}
              <span>{str(it.text)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Who acts on each step, the step, and what finishing it unblocks; a live page offers to start a conversation from a step. */
export function NextStepsBlock({ block, ctx }: BlockProps) {
  const items = objects(block.items).filter((it) => str(it.text).trim());
  const start = ctx.startConversation;
  return (
    <div data-michi-block="next-steps">
      <BlockTitle text={str(block.title)} />
      <ul className="michi-doc-steps">
        {items.map((it, i) => {
          const user = it.who === 'user';
          const unblocks = str(it.unblocks).trim();
          return (
            <li key={i} className="michi-doc-steps__item">
              <span className="michi-tag michi-doc-steps__who" data-who={user ? 'user' : 'agent'}>{user ? 'You' : 'Agent'}</span>
              <span className="michi-doc-steps__what">
                {str(it.text)}
                {unblocks && <span className="michi-doc-steps__unblocks">Unblocks {unblocks}</span>}
              </span>
              {start && (
                <Button size="sm" className="michi-doc-steps__start" onClick={() => start(str(it.text))}>
                  <MessageSquare size={12} strokeWidth={1.7} aria-hidden="true" />Start a conversation
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
