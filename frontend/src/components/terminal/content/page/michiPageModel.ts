import type { MichiPageBlock } from 'michi-shared';
import { pageBlockText, parsePageBlockInput } from 'michi-shared';

// Defensive presentation helpers for native Page blocks. Every field read
// here may be missing or malformed; an individual block must not break its page.

export type Loose = Record<string, unknown>;

export const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A field as text: strings as they are, finite numbers in words, anything else ''. */
export function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function objects(v: unknown): Loose[] {
  return list(v).filter(isObj);
}

/** Child blocks of a container slot; anything that is not a block is dropped. */
export function blocksOf(v: unknown): MichiPageBlock[] {
  return list(v).filter((b): b is MichiPageBlock => isObj(b) && typeof b.type === 'string');
}

/** The address when it is https with a host; anything else is not a link. */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' && url.hostname ? trimmed : null;
  } catch {
    return null;
  }
}

/** First `n` characters (by code point), cut back to a word break when one is near, plus `…`. */
export function clipWords(s: string, n: number): string {
  const chars = [...s.trim()];
  if (chars.length <= n) return chars.join('');
  let cut = chars.slice(0, n).join('');
  const nextIsBreak = /\s/.test(chars[n] ?? '');
  const space = cut.lastIndexOf(' ');
  if (!nextIsBreak && space >= n * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

/** Markdown down to its words, on one line. Underscores inside a word (snake_case) are words too. */
export function plainText(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`~#>|]+/g, '')
    .replace(/(^|[^\p{L}\p{N}_])_+|_+(?=[^\p{L}\p{N}_]|$)/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownHeading(text: string): string {
  const match = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
  return match ? plainText(match[1]) : '';
}

// Prefer readable labels even for blocks with unknown types.
const NAMES = ['title', 'question', 'label', 'name', 'caption', 'alt', 'text'];
/** Fields that say nothing to a person about what the block is. */
const NOT_NAMES = new Set([
  'id', 'type', 'sources', 'edit', 'staleFor', 'url', 'image', 'avatar', 'before', 'after', 'code',
  'databaseId', 'viewId', 'threadId', 'component', 'componentId', 'lang', 'interaction', 'visibility', 'blockIds', 'action',
]);

/** What to call a block no one wrote a handle for: its title, question, label or name, else its first words; '' when it has none. */
export function looseTitle(b: object): string {
  const o = b as Loose;
  const pick = (k: string) => {
    const v = o[k];
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  };
  return NAMES.map(pick).find(Boolean)
    || Object.keys(o).filter((k) => !NOT_NAMES.has(k)).map(pick).find(Boolean)
    || '';
}

/** What each catalog block is called when it has no words of its own. */
const TYPE_LABELS = new Map<string, string>([
  ['heading', 'Heading'], ['markdown', 'Text'], ['callout', 'Callout'], ['quote', 'Quote'], ['toggle', 'Toggle'],
  ['columns', 'Columns'], ['grid', 'Responsive grid'], ['tabs', 'Tabs'], ['divider', 'Divider'], ['toc', 'Contents'], ['code', 'Code'],
  ['diff', 'Diff'], ['math', 'Formula'], ['mermaid', 'Diagram'], ['keyvalue', 'Details'], ['tags', 'Tags'], ['status', 'Status'],
  ['metrics', 'Metrics'], ['stat', 'Stat'], ['progress', 'Progress'], ['ring', 'Progress rings'], ['gauge', 'Gauge'],
  ['plan-actual', 'Plan vs actual'], ['leaderboard', 'Leaderboard'], ['rating', 'Rating'], ['compare', 'Compare'],
  ['pros-cons', 'Pros and cons'], ['checklist', 'Checklist'], ['next-steps', 'Next steps'], ['choice', 'Choice'], ['table', 'Table'],
  ['chart', 'Chart'], ['timeline', 'Timeline'], ['milestones', 'Milestones'], ['stepper', 'Steps'],
  ['agenda', 'Agenda'], ['calendar', 'Calendar'], ['gantt', 'Gantt'], ['countdown', 'Countdown'], ['clocks', 'Clocks'],
  ['image', 'Image'], ['gallery', 'Gallery'], ['before-after', 'Before and after'], ['carousel', 'Carousel'],
  ['video', 'Video'], ['audio', 'Audio'], ['embed', 'Embedded page'], ['link', 'Link'], ['file', 'File'],
  ['thread-card', 'Thread'], ['threads', 'Threads'], ['person', 'Person'], ['place', 'Place'], ['actions', 'Actions'],
  ['form', 'Form'], ['poll', 'Poll'], ['database', 'Table'], ['database-ref', 'Database'], ['home-section', 'Attention list'], ['task-view', 'Task board'], ['custom', 'Widget'],
  ['criteria', 'Success criteria'], ['conflict', 'Conflict'], ['forgot', 'You may have forgotten'], ['component', 'Component'],
]);

export function typeLabel(type: string): string {
  return TYPE_LABELS.get(type) ?? (type || 'Block');
}

/** A short name for a block: its heading, title or question, else its first words, else what kind of block it is. */
export function blockLabel(b: MichiPageBlock): string {
  const label = b.type === 'heading' ? str(b.text)
    : b.type === 'markdown' ? markdownHeading(str(b.text)) || clipWords(plainText(str(b.text)), 24)
    : b.type === 'choice' ? str(b.question) || str(b.title)
    : b.type === 'callout' ? str(b.title) || clipWords(plainText(str(b.text)), 24)
    : b.type === 'metrics' ? clipWords(objects(b.items).map((m) => str(m.label)).filter(Boolean).join(', '), 40)
    : str(b.title) || clipWords(looseTitle(b), 40);
  return label.trim() || typeLabel(b.type);
}

const AMOUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** `3d`, `40%`, `950 USD`; nothing yet (zero or missing) reads as `—`. */
const pad2 = (n: number) => String(n).padStart(2, '0');
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * A timeline entry's time as the page shows it: `MM-DD HH:mm` in local time,
 * `MM-DD` for a bare date, with the year when it is not this year. Epoch
 * milliseconds and ISO dates are read; any other text is shown as it is.
 */
export function timelineWhen(at: unknown, now: Date = new Date()): { text: string; dateTime?: string } {
  if (typeof at === 'string') {
    const date = ISO_DATE.exec(at);
    if (date) return { text: `${Number(date[1]) === now.getFullYear() ? '' : `${date[1]}-`}${date[2]}-${date[3]}`, dateTime: at };
  }
  const ms = typeof at === 'number' && Number.isFinite(at) ? at
    : typeof at === 'string' && ISO_DATE_TIME.test(at) ? Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return { text: str(at) };
  const d = new Date(ms);
  // An epoch past what a date holds keeps its number.
  if (!Number.isFinite(d.getTime())) return { text: String(at) };
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}-`;
  return { text: `${year}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`, dateTime: d.toISOString() };
}

export function formatAmount(n: number | null, unit: string): string {
  if (n == null || n <= 0) return '—';
  const u = unit.trim();
  if (!u) return AMOUNT.format(n);
  return /^[a-z%]{1,2}$/i.test(u) ? `${AMOUNT.format(n)}${u}` : `${AMOUNT.format(n)} ${u}`;
}

export const pct = (n: number) => `${Math.round(n * 100)}%`;

export interface PlanActualRow {
  label: string;
  planned: number;
  actual: number;
  forecast: number | null;
  unit: string;
  /** Bar extents as fractions of the row's track. */
  planWidth: number;
  actualWidth: number;
  overStart: number;
  overWidth: number;
  forecastStart: number;
  forecastWidth: number;
  over: boolean;
  text: string;
}

export interface PlanActualModel {
  rows: PlanActualRow[];
  /** Where today falls on the shared track, 0..1; null when the block gives no `today` or rows share no scale. */
  today: number | null;
  hasOver: boolean;
  hasForecast: boolean;
}

const frac = (n: number, scale: number) => (scale > 0 ? Math.min(1, Math.max(0, n / scale)) : 0);

const DAY_MS = 86_400_000;

/** A YYYY-MM-DD day as a count of days since 1970, or null. */
export function dayNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const ms = Date.UTC(year, month - 1, day);
  return Number.isFinite(ms) ? Math.round(ms / DAY_MS) : null;
}

/** The local calendar day `now` falls on, as a day count. */
export function localDayNumber(now: number): number {
  const date = new Date(now);
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

const DAY_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** `Oct 10`. */
export const dayLabel = (day: number) => DAY_LABEL.format(new Date(day * DAY_MS));

/** A bar's place on the shared track, as fractions of it. */
export interface TrackSpan { start: number; width: number }

export interface PlanScheduleRow {
  label: string;
  plan: TrackSpan;
  /** The part of the actual inside the plan; past the plan's end it is `over`. */
  actual: TrackSpan | null;
  over: TrackSpan | null;
  forecast: TrackSpan | null;
  overPlan: boolean;
  /** `3d / 2d`: days taken against days planned. */
  text: string;
  /** The row in words, for the bars that carry it by sight. */
  words: string;
}

export interface PlanScheduleModel {
  rows: PlanScheduleRow[];
  /** Where today falls on the track, or null when it is outside it. */
  today: number | null;
  /** Labels under the track; ones that would crowd another are left out. */
  axis: Array<{ at: number; text: string; kind: 'start' | 'end' | 'today' | 'plan-end' }>;
  hasOver: boolean;
  hasForecast: boolean;
}

/** A plan-actual block in days rather than amounts. */
export function isPlanSchedule(block: MichiPageBlock): boolean {
  return objects(block.items).some((it) => typeof it.planStart === 'string');
}

/**
 * Bars for a plan-actual block in days: each phase's plan as an outline, what
 * has happened filled (an actual still under way runs to today), the part
 * past the plan's end in the warning colour and a dashed forecast, all on one
 * calendar track with today as a line. Days count both ends.
 */
export function planScheduleModel(block: MichiPageBlock, now: number): PlanScheduleModel {
  const today = localDayNumber(now);
  const phases = objects(block.items).flatMap((it) => {
    const label = str(it.label).trim();
    const ps = dayNumber(it.planStart);
    const pe = dayNumber(it.planEnd);
    if (!label || ps === null || pe === null || pe < ps) return [];
    const as = dayNumber(it.actualStart);
    const ae = dayNumber(it.actualEnd);
    const fe = dayNumber(it.forecastEnd);
    // A start still ahead of today has not begun; an end given is the end, whatever today is.
    const started = as !== null && (ae !== null ? ae >= as : as <= today);
    const actualEnd = started ? ae ?? today : null;
    const forecastStart = fe === null ? null : dayNumber(it.forecastStart) ?? (started && ae === null ? today + 1 : ps);
    const forecast = fe !== null && forecastStart !== null && fe >= forecastStart ? { from: forecastStart, to: fe } : null;
    return [{ label, ps, pe, as: started ? as : null, actualEnd, ended: ae !== null, forecast }];
  });
  if (!phases.length) return { rows: [], today: null, axis: [], hasOver: false, hasForecast: false };
  const lo = Math.min(...phases.flatMap((p) => [p.ps, ...(p.as !== null ? [p.as] : []), ...(p.forecast ? [p.forecast.from] : [])]));
  const hi = Math.max(...phases.flatMap((p) => [p.pe, ...(p.actualEnd !== null ? [p.actualEnd] : []), ...(p.forecast ? [p.forecast.to] : [])]));
  const days = hi - lo + 1;
  const bar = (from: number, to: number): TrackSpan | null => (to < from ? null : { start: (from - lo) / days, width: (to - from + 1) / days });
  const rows = phases.map((p): PlanScheduleRow => {
    const planned = p.pe - p.ps + 1;
    const taken = p.as !== null && p.actualEnd !== null ? p.actualEnd - p.as + 1 : null;
    const over = p.as !== null && p.actualEnd !== null && p.actualEnd > p.pe ? bar(Math.max(p.as, p.pe + 1), p.actualEnd) : null;
    const overPlan = over !== null || (taken !== null && taken > planned);
    const actualWords = p.as === null ? 'not started' : `actual ${dayLabel(p.as)} to ${p.ended ? dayLabel(p.actualEnd!) : 'today'}`;
    return {
      label: p.label,
      plan: bar(p.ps, p.pe)!,
      actual: p.as !== null && p.actualEnd !== null ? bar(p.as, Math.min(p.actualEnd, p.pe)) : null,
      over,
      forecast: p.forecast ? bar(p.forecast.from, p.forecast.to) : null,
      overPlan,
      text: `${taken === null ? '—' : `${taken}d`} / ${planned}d`,
      words: `${p.label}: planned ${dayLabel(p.ps)} to ${dayLabel(p.pe)}; ${actualWords}${p.forecast ? `; forecast to ${dayLabel(p.forecast.to)}` : ''}${overPlan ? '; over plan' : ''}`,
    };
  });
  const todayAt = today >= lo && today <= hi ? (today - lo + 0.5) / days : null;
  const planEnd = Math.max(...phases.map((p) => p.pe));
  // Today first, then the ends, then the plan's end: each label keeps clear of the ones placed before it.
  const candidates: PlanScheduleModel['axis'] = [
    ...(todayAt === null ? [] : [{ at: todayAt, text: 'today', kind: 'today' as const }]),
    { at: 0, text: dayLabel(lo), kind: 'start' },
    { at: 1, text: dayLabel(hi), kind: 'end' },
    ...(planEnd < hi ? [{ at: (planEnd - lo + 1) / days, text: 'plan end', kind: 'plan-end' as const }] : []),
  ];
  const axis: PlanScheduleModel['axis'] = [];
  for (const label of candidates) if (axis.every((placed) => Math.abs(placed.at - label.at) >= 0.14)) axis.push(label);
  return {
    rows,
    today: todayAt,
    axis: axis.sort((a, b) => a.at - b.at),
    hasOver: rows.some((r) => r.over !== null || r.overPlan),
    hasForecast: rows.some((r) => r.forecast !== null),
  };
}

/**
 * Bars for a plan-actual block (`items: {label, planned, actual, unit}`):
 * the plan as an outline, the actual filled up to the plan with any overrun
 * after it, and a dashed forecast when an item carries one. Rows in one unit
 * share a scale so they compare; mixed units scale each row on its own.
 */
export function planActualModel(block: MichiPageBlock): PlanActualModel {
  const items = objects(block.items).filter((it) => str(it.label).trim());
  const units = new Set(items.map((it) => str(it.unit).trim()));
  const shared = units.size <= 1;
  const todayValue = num(block.today);
  const top = Math.max(0, ...items.map((it) => Math.max(num(it.planned) ?? 0, num(it.actual) ?? 0, num(it.forecast) ?? 0)),
    shared && todayValue != null ? todayValue : 0);
  const rows = items.map((it): PlanActualRow => {
    const planned = Math.max(0, num(it.planned) ?? 0);
    const actual = Math.max(0, num(it.actual) ?? 0);
    const rawForecast = num(it.forecast);
    const forecast = rawForecast != null && rawForecast > actual ? rawForecast : null;
    const unit = str(it.unit).trim();
    const scale = shared ? top : Math.max(planned, actual, forecast ?? 0);
    const within = Math.min(actual, planned);
    const over = actual > planned;
    return {
      label: str(it.label).trim(),
      planned,
      actual,
      forecast,
      unit,
      planWidth: frac(planned, scale),
      actualWidth: frac(within, scale),
      overStart: frac(planned, scale),
      overWidth: over ? frac(actual - planned, scale) : 0,
      forecastStart: frac(actual, scale),
      forecastWidth: forecast != null ? frac(forecast - actual, scale) : 0,
      over,
      text: `${formatAmount(actual, unit)} / ${formatAmount(planned, unit)}`,
    };
  });
  return {
    rows,
    today: shared && todayValue != null && top > 0 ? frac(todayValue, top) : null,
    hasOver: rows.some((r) => r.over),
    hasForecast: rows.some((r) => r.forecast != null),
  };
}
const SUMMARY_DEPTH = 3;

/** A block's whole text, as Copy puts it on the clipboard: what blockSummary says, never cut short. */
export function blockFullText(block: MichiPageBlock): string {
  return summaryLines(block, 0).filter((l) => l.trim()).join('\n');
}

/** The block's content as a native page block, without the metadata Michi and native pages add to it. */
function nativeContent(b: MichiPageBlock) {
  const { id: _id, edit: _edit, sources: _sources, staleFor: _staleFor, ...content } = b;
  return parsePageBlockInput(content);
}

function summaryLines(b: MichiPageBlock, depth: number): string[] {
  if (depth > SUMMARY_DEPTH) return [];
  const label = blockLabel(b);
  const kids = (v: unknown) => blocksOf(v).flatMap((c) => summaryLines(c, depth + 1));
  // Shapes only native pages hold (a schedule, thread cards by conversation) read as the block catalog writes them.
  if ((b.type === 'plan-actual' && isPlanSchedule(b)) || (b.type === 'threads' && Array.isArray(b.nodeIds))) {
    const native = nativeContent(b);
    if (native) return pageBlockText(native).split('\n');
  }
  switch (b.type) {
    case 'heading':
    case 'markdown':
      return [str(b.text) || label];
    case 'callout':
      return str(b.title) ? [label, str(b.text)] : [str(b.text) || label];
    case 'quote':
      return [str(b.text), str(b.cite) ? `— ${str(b.cite)}` : ''];
    case 'code':
      return [label, str(b.code)];
    case 'keyvalue':
      return [label, ...objects(b.items).map((it) => `${str(it.key)}: ${str(it.value)}`)];
    case 'tags':
      return [label, objects(b.items).map((it) => str(it.label)).filter(Boolean).join(', ')];
    case 'status':
      return [`${str(b.label)}${str(b.summary) ? `: ${str(b.summary)}` : ''}`, str(b.note)];
    case 'metrics':
      return [label, ...objects(b.items).map((m) => {
        const hint = str(m.hint) || str(m.note);
        return `${str(m.label)}: ${str(m.value)}${hint ? ` (${hint})` : ''}`;
      })];
    case 'stat':
      return [`${label}: ${str(b.value)}${str(b.delta) ? ` ${str(b.delta)}` : ''}`];
    case 'progress': {
      const actual = num(b.actual);
      const expected = num(b.expected);
      return [label, `actual ${actual == null ? '—' : pct(actual)}${expected == null ? '' : ` · plan by now ${pct(expected)}`}`];
    }
    case 'plan-actual':
      return [label, ...planActualModel(b).rows.map((r) =>
        `${r.label}: actual ${formatAmount(r.actual, r.unit)} / planned ${formatAmount(r.planned, r.unit)}`)];
    case 'compare':
      return [label, ...objects(b.options).map((o, i) => {
        const value = [str(o.value), str(o.unit)].filter(Boolean).join(' ');
        const pros = list(o.pros).map(str).filter(Boolean);
        const cons = list(o.cons).map(str).filter(Boolean);
        return [str(o.name), value, str(o.note)].filter(Boolean).join(' — ')
          + (pros.length ? ` (+ ${pros.join('; ')})` : '') + (cons.length ? ` (− ${cons.join('; ')})` : '')
          + (b.picked === i ? ' (picked)' : o.lean === true ? ' (leaning)' : '');
      })];
    case 'pros-cons':
      return [label, `Pros: ${list(b.pros).map(str).filter(Boolean).join('; ')}`, `Cons: ${list(b.cons).map(str).filter(Boolean).join('; ')}`];
    case 'checklist':
      return [label, ...objects(b.items).map((it) => `[${it.done === true ? 'x' : ' '}] ${str(it.text)}`)];
    case 'choice':
      return [label, ...list(b.options).map(str).filter(Boolean).map((o) => `- ${o}`)];
    case 'table':
      return [label, list(b.columns).map(str).join(' | '), ...list(b.rows).map((r) => list(r).map(str).join(' | '))];
    case 'database': {
      const columns = objects(b.columns);
      return [
        label,
        columns.map((c) => str(c.name)).join(' | '),
        ...objects(b.rows).map((r) => {
          const values = isObj(r.values) ? r.values : {};
          return columns.map((c) => cellText(values[str(c.id)])).join(' | ');
        }),
      ];
    }
    case 'milestones':
      return [label, ...objects(b.items).map((it) => `${str(it.date)} — ${str(it.label)}${it.done === true ? ' (done)' : ''}${str(it.note) ? `: ${str(it.note)}` : ''}`)];
    case 'timeline':
      return [label, ...objects(b.items).map((it) => {
        const text = str(it.text) || str(it.detail);
        return `${timelineWhen(it.at).text} — ${str(it.title)}${text ? `: ${text}` : ''}`;
      })];
    case 'next-steps':
      return [label, ...objects(b.items).map((it) =>
        `${it.who === 'user' ? 'You' : 'Agent'}: ${str(it.text)}${str(it.unblocks) ? ` (unblocks ${str(it.unblocks)})` : ''}`)];
    case 'link':
      return [`${label} — ${str(b.url)}`];
    case 'columns':
      return list(b.columns).flatMap(kids);
    case 'grid':
      return objects(b.regions).flatMap((region) => [str(region.title), ...kids(region.blocks)]);
    case 'tabs':
      return objects(b.tabs).flatMap((tab) => [`${str(tab.label)}:`, ...kids(tab.blocks)]);
    case 'toggle':
      return [label, ...kids(b.blocks)];
    default: {
      // A native page's block reads as the block catalog writes it.
      const native = nativeContent(b);
      return native ? pageBlockText(native).split('\n') : [label];
    }
  }
}


/** A database cell as words: lists joined, dates as their range, booleans as ✓. */
export function cellText(v: unknown): string {
  if (typeof v === 'boolean') return v ? '✓' : '';
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ');
  if (isObj(v)) {
    const start = str(v.start);
    const end = str(v.end);
    return start && end ? `${start} → ${end}` : start;
  }
  return str(v);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;



function clipChars(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : `${chars.slice(0, n - 1).join('').trimEnd()}…`;
}



/** The outline entry for a top-level block; '' when the block carries no title of its own. */
export function outlineTitle(b: MichiPageBlock): string {
  const title = b.type === 'heading' ? str(b.text)
    : b.type === 'markdown' ? markdownHeading(str(b.text))
    : str(b.title) || str(b.question) || str(b.label) || str(b.name);
  return clipWords(title.trim(), 60);
}



export interface OutlineBlock {
  /** The block's place among the page's top-level blocks. */
  index: number;
  title: string;
  /** 1 for a section; 2 for a titled block under the section heading before it. */
  depth: 1 | 2;
}



/**
 * The page's own outline: headings (and Markdown that opens with one) are
 * sections; a titled block nests under the section before it. An agent's
 * note about another block is not a section.
 */
export function outlineBlocks(blocks: readonly MichiPageBlock[]): OutlineBlock[] {
  const out: OutlineBlock[] = [];
  let underHeading = false;
  blocks.forEach((b, index) => {
    if (typeof b.staleFor === 'string' && b.staleFor) return;
    const title = outlineTitle(b);
    if (!title) return;
    const heading = b.type === 'heading' || b.type === 'markdown';
    if (heading && !(b.type === 'heading' && b.level === 3 && underHeading)) {
      out.push({ index, title, depth: 1 });
      underHeading = true;
      return;
    }
    out.push({ index, title, depth: underHeading ? 2 : 1 });
  });
  return out;
}



/** The most a block's quote carries into a Michi thread. */
export const BLOCK_SUMMARY_MAX = 1500;



/** A block as compact plain text, its label first: what Ask and Branch quote into the new thread. */
export function blockSummary(block: MichiPageBlock): string {
  return clipChars(summaryLines(block, 0).filter((l) => l.trim()).join('\n'), BLOCK_SUMMARY_MAX);
}
