/**
 * The native page block catalog: one entry per block type says what the
 * block is called, how agents are told about it (a sentence, its fields, its
 * JSON Schema) and how it reads as plain text. Tool schemas, tool
 * descriptions, one-line summaries and the component library all come from
 * here, so a new block is one entry plus its renderer. Validation stays in
 * blocks.ts.
 */
import { RICH_BLOCK_CATALOG, richContentText } from './richCatalog';
import { richBlockJsonSchema, richChartSchema } from './richBlocks';
import { PAGE_VIEW_PRESENTATIONS } from './viewInteractions';
import {
  BLOCK_TONES, CHART_KINDS, CRITERION_STATES, FORGOT_STATES, METRIC_TONES, NEXT_STEP_WHO, PAGE_BLOCK_LIMITS as LIMITS,
  parsePageBlockInput, type CriterionState, type PageBlockInput, type PlanActualAmount, type PlanActualSpan,
} from './blocks';

export type PageBlockType = PageBlockInput['type'];
export type PageBlockOf<T extends PageBlockType> = Extract<PageBlockInput, { type: T }>;
export type PageBlockCategory = 'text' | 'data' | 'time' | 'decisions' | 'media' | 'conversations' | 'references';

/** What the component library calls each category, in its order. */
export const PAGE_BLOCK_CATEGORIES: ReadonlyArray<{ id: PageBlockCategory; label: string }> = [
  { id: 'text', label: 'Text & structure' },
  { id: 'data', label: 'Data & metrics' },
  { id: 'time', label: 'Time & planning' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'media', label: 'Media' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'references', label: 'Pages & data' },
];

export interface PageBlockCatalogEntry<T extends PageBlockType = PageBlockType> {
  type: T;
  /** The block's name in the component library. */
  label: string;
  category: PageBlockCategory;
  /** One line for the person browsing the component library. */
  blurb: string;
  /** One sentence for an agent: what the block shows and when to use it. */
  describe: string;
  /** The content fields in brief, as tool descriptions list them. */
  fields: string;
  /** JSON Schema of the content, as tool parameters take it. */
  schema: Record<string, unknown>;
  /** Sample content, for docs and previews; none for blocks that point at a page, database or component. */
  example?: PageBlockOf<T>;
  /** The block's own title, '' when it has none. */
  title(block: PageBlockOf<T>): string;
  /** The block as plain text, one fact per line; summaries, page manifests and change previews read it. */
  text(block: PageBlockOf<T>): string;
}

// ── JSON Schema pieces ──────────────────────────────────────────────────────

const str = (max: number) => ({ type: 'string', maxLength: max });
const id = { type: 'string', minLength: 1, maxLength: 200 };
const title = str(LIMITS.title);
const at = { description: 'Epoch milliseconds, or an ISO 8601 date (YYYY-MM-DD) or date-time (YYYY-MM-DDTHH:MM, optional seconds and zone)',
  anyOf: [{ type: 'integer', minimum: 0, maximum: 8_640_000_000_000_000 }, { type: 'string', maxLength: LIMITS.at }] };
const day = { type: 'string', minLength: 10, maxLength: 10, description: 'YYYY-MM-DD' };
const amount = { type: 'number', minimum: 0, maximum: LIMITS.amount };
const list = (items: unknown, max: number, min = 0) => ({ type: 'array', ...(min ? { minItems: min } : {}), maxItems: max, items });
const object = (properties: Record<string, unknown>, required: string[], description?: string) =>
  ({ type: 'object', ...(description ? { description } : {}), properties, required, additionalProperties: false });
const block = (type: PageBlockType, describe: string, properties: Record<string, unknown>, required: string[]) =>
  object({ type: { type: 'string', enum: [type] }, ...properties }, ['type', ...required], describe);
const viewId = { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,79}$' };
const viewAction = object({ type: { const: 'open-view' }, viewId, presentation: { type: 'string', enum: [...PAGE_VIEW_PRESENTATIONS] } }, ['type', 'viewId']);
const interaction = object({ label: { ...title, minLength: 1 }, action: viewAction }, ['label', 'action']);

// ── Plain text ──────────────────────────────────────────────────────────────

const lines = (...parts: Array<string | undefined | false>) => parts.filter((part): part is string => !!part && part.trim() !== '').join('\n');
/** A day stays as written; epoch milliseconds read as an ISO date-time. */
/** When, as written; an epoch as its UTC date and minute, or as the number when no date holds it. */
const atText = (value: number | string): string => {
  if (typeof value !== 'number') return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16).replace('T', ' ') : String(value);
};
const amountText = (value: number, unit?: string) => `${value}${unit ? ` ${unit}` : ''}`;
const isSpan = (item: PlanActualAmount | PlanActualSpan): item is PlanActualSpan => 'planStart' in item;
const CRITERION_WORDS: Record<CriterionState, string> = { done: 'done', 'in-progress': 'in progress', stalled: 'stalled', 'not-started': 'not started' };

function planLine(item: PlanActualAmount | PlanActualSpan): string {
  if (!isSpan(item)) {
    const forecast = item.forecast === undefined ? '' : `, forecast ${amountText(item.forecast, item.unit)}`;
    return `${item.label}: actual ${amountText(item.actual, item.unit)} / planned ${amountText(item.planned, item.unit)}${forecast}`;
  }
  const actual = item.actualStart ? `, actual ${item.actualStart} → ${item.actualEnd ?? 'now'}` : ', not started';
  const forecast = item.forecastEnd ? `, forecast ${item.forecastStart ? `${item.forecastStart} → ` : 'to '}${item.forecastEnd}` : '';
  return `${item.label}: planned ${item.planStart} → ${item.planEnd}${actual}${forecast}`;
}

function markdownTitle(text: string): string {
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return /^#{1,6}\s/.test(first) ? first.replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '') : '';
}

const own = (block: { title?: string }) => block.title?.trim() ?? '';

// ── The catalog ─────────────────────────────────────────────────────────────

export const PAGE_BLOCK_CATALOG: { readonly [T in PageBlockType]: PageBlockCatalogEntry<T> } = {
  heading: {
    type: 'heading', label: 'Heading', category: 'text',
    blurb: 'Give the next section a clear title.',
    describe: 'A section heading.',
    fields: '{text}',
    schema: block('heading', 'A section heading.', { text: str(LIMITS.title) }, ['text']),
    example: { type: 'heading', text: 'What happens next' },
    title: (b) => b.text.trim(),
    text: (b) => b.text,
  },
  markdown: {
    type: 'markdown', label: 'Text', category: 'text',
    blurb: 'Write summaries, lists and links using Markdown.',
    describe: 'Prose in Markdown: paragraphs, lists, links, emphasis, small tables, https images. Optional segmentSources maps every rendered paragraph, heading or list item, in order, to its exact unchanged text and native conversation sources. At most 100 sources total; never invent source IDs.',
    fields: '{text, segmentSources?: [{text (exact segment text), sources: [{nodeId, turnId, assistantId}]}]} (one entry per segment in order, at most 100 sources total)',
    schema: block('markdown', 'Prose in Markdown, optionally with exact text anchors and native conversation sources for every segment in reading order.', {
      text: str(LIMITS.text),
      segmentSources: list(object({ text: str(LIMITS.text), sources: list(object({ nodeId: id, turnId: id, assistantId: id }, ['nodeId', 'turnId', 'assistantId']), 100) }, ['text', 'sources']), 100),
    }, ['text']),
    example: { type: 'markdown', text: '### A little context\nThe release is ready for a final review.\n\n- Installer checked\n- Release notes drafted\n- Launch date to confirm' },
    title: (b) => markdownTitle(b.text),
    text: (b) => b.text,
  },
  callout: {
    type: 'callout', label: 'Callout', category: 'text',
    blurb: 'Call out a blocker, a note, something ready or a conflict with the plan.',
    describe: 'A boxed note under a caption: tone info (a note), success (ready), warn (a blocker) or danger (a conflict with the plan).',
    fields: '{text, title?, tone?: info|success|warn|danger}',
    schema: block('callout', 'A boxed note under a caption: tone info (a note), success (ready), warn (a blocker) or danger (a conflict with the plan).',
      { text: str(LIMITS.text), title, tone: { type: 'string', enum: [...BLOCK_TONES] } }, ['text']),
    example: { type: 'callout', title: 'Blockers', text: 'The schema naming is still open, so the migration and the rollback script both wait on it.', tone: 'warn' },
    title: own,
    text: (b) => lines(b.title, b.text),
  },
  checklist: {
    type: 'checklist', label: 'Checklist', category: 'time',
    blurb: 'Track small tasks. Tick an item right on the page.',
    describe: 'Items to tick, done true or false; the person ticks them on the page.',
    fields: '{title?, items: [{text, done}]} (at most 50)',
    schema: block('checklist', 'Items to tick, done true or false; the person ticks them on the page.', {
      title, items: list(object({ text: str(LIMITS.title), done: { type: 'boolean' } }, ['text', 'done']), LIMITS.checklistItems),
    }, ['items']),
    example: { type: 'checklist', title: 'Before the release', items: [{ text: 'Review the release notes', done: true }, { text: 'Verify the installer', done: false }, { text: 'Choose a launch date', done: false }] },
    title: own,
    text: (b) => lines(b.title, ...b.items.map((item) => `${item.done ? '[x]' : '[ ]'} ${item.text}`)),
  },
  metrics: {
    type: 'metrics', label: 'Metrics', category: 'data',
    blurb: 'A few key numbers, each with a short note.',
    describe: 'Figures in a row: label above, the value large, an optional note below. tone accent highlights a value.',
    fields: '{items: [{label, value, tone?: default|accent, note?, action?: {type:"open-view",viewId,presentation?:inline|drawer|modal}}]} (at most 12; action is optional)',
    schema: block('metrics', 'Figures in a row: label above, the value large, an optional note below. tone accent highlights a value.', {
      items: list(object({ label: str(LIMITS.title), value: str(LIMITS.value), tone: { type: 'string', enum: [...METRIC_TONES] }, note: str(LIMITS.title), action: viewAction }, ['label', 'value']), LIMITS.metricsItems),
    }, ['items']),
    example: { type: 'metrics', items: [{ label: 'Planned', value: '10 days', note: 'Oct 10 → Oct 24' }, { label: 'Tasks', value: '14 / 22', note: '64% done' }, { label: 'ETA', value: 'Oct 27', note: '3 days late', tone: 'accent' }] },
    title: () => '',
    text: (b) => lines(...b.items.map((item) => [item.label, item.value, item.note].filter(Boolean).join(' · '))),
  },
  'next-steps': {
    type: 'next-steps', label: 'Next steps', category: 'time',
    blurb: 'Separate what you need to decide from what the assistant can do.',
    describe: 'Next steps: who acts (the user or the agent), the step, and what it unblocks (a noun phrase; the page shows it after "Unblocks").',
    fields: '{title?, items: [{who: user|agent, text, unblocks? (a noun phrase shown after "Unblocks")}]} (at most 20)',
    schema: block('next-steps', 'Next steps: who acts (the user or the agent), the step, and what it unblocks (a noun phrase; the page shows it after "Unblocks").', {
      title, items: list(object({ who: { type: 'string', enum: [...NEXT_STEP_WHO] }, text: str(LIMITS.line), unblocks: str(LIMITS.title) }, ['who', 'text']), LIMITS.nextStepsItems),
    }, ['items']),
    example: { type: 'next-steps', title: 'Up next', items: [{ who: 'user', text: 'Choose the launch date' }, { who: 'agent', text: 'Prepare the release notes', unblocks: 'Early access invitations' }] },
    title: own,
    text: (b) => lines(b.title, ...b.items.map((item) => `${item.who === 'user' ? 'You' : 'Agent'}: ${item.text}${item.unblocks ? ` (unblocks ${item.unblocks})` : ''}`)),
  },
  timeline: {
    type: 'timeline', label: 'Timeline', category: 'time',
    blurb: 'Milestones and progress in a simple dated list.',
    describe: 'Dated entries, newest first. at is epoch milliseconds or an ISO 8601 date or date-time.',
    fields: '{title?, items: [{title, at: epoch ms or ISO 8601 date/date-time, detail?, tone?: info|success|warn|danger}]} (at most 50, newest first)',
    schema: block('timeline', 'Dated entries, newest first. at is epoch milliseconds or an ISO 8601 date or date-time.', {
      title, items: list(object({ title: str(LIMITS.title), at, detail: str(LIMITS.line), tone: { type: 'string', enum: [...BLOCK_TONES] } }, ['title', 'at']), LIMITS.timelineItems),
    }, ['items']),
    example: { type: 'timeline', title: 'Release progress', items: [{ title: 'Early access', at: '2026-10-25', detail: 'Invite the first group of testers' }, { title: 'Design reviewed', at: '2026-10-21', tone: 'success' }] },
    title: own,
    text: (b) => lines(b.title, ...b.items.map((item) => `${atText(item.at)} · ${item.title}${item.detail ? `: ${item.detail}` : ''}`)),
  },
  'plan-actual': {
    type: 'plan-actual', label: 'Plan vs actual', category: 'data',
    blurb: 'Each phase or item against its plan, with overruns and a forecast.',
    describe: 'Plan against actual per item, all in amounts (planned, actual, forecast in one unit; today places today on that scale) or all in days '
      + '(planStart/planEnd, actualStart/actualEnd, forecastStart/forecastEnd as YYYY-MM-DD, both ends counted; actualStart without actualEnd is still under way). Overruns are flagged and today shows as a line.',
    fields: '{title?, items: [{label, planned, actual, forecast?, unit?}] or [{label, planStart, planEnd, actualStart?, actualEnd?, forecastStart?, forecastEnd?} (days YYYY-MM-DD; each start on or before its end; actualEnd needs actualStart, forecastStart needs forecastEnd)], today? (amounts only)} (1-20 items, all in amounts or all in days)',
    schema: block('plan-actual', 'Plan against actual per item, all in amounts or all in days (YYYY-MM-DD, both ends counted). Overruns are flagged and today shows as a line.', {
      title,
      items: list({ oneOf: [
        object({ label: title, planned: amount, actual: amount, forecast: amount, unit: str(LIMITS.unit) }, ['label', 'planned', 'actual'], 'Measured in an amount.'),
        object({ label: title, planStart: day, planEnd: day, actualStart: day, actualEnd: day, forecastStart: day, forecastEnd: day }, ['label', 'planStart', 'planEnd'],
          'Measured in days. No actualStart: not started; actualStart alone: under way until today. A forecast is where it should start and end from here.'),
      ] }, LIMITS.planActualItems, 1),
      today: { ...amount, description: 'Amounts only: where today falls on the same scale.' },
    }, ['items']),
    example: { type: 'plan-actual', title: 'Time budget', items: [{ label: 'Design', planned: 16, actual: 14, unit: 'h' }, { label: 'Build', planned: 32, actual: 36, unit: 'h' }, { label: 'Testing', planned: 12, actual: 5, forecast: 10, unit: 'h' }] },
    title: own,
    text: (b) => lines(b.title || 'Plan vs actual', ...b.items.map(planLine)),
  },
  compare: {
    type: 'compare', label: 'Compare', category: 'decisions',
    blurb: 'Options side by side. Pick one right on the page.',
    describe: 'Options side by side for a decision the person makes: a value with its unit, a note, pros and cons; lean marks the one you recommend. '
      + 'The person picks one on the page and picked holds its index; set picked only when they already chose in a conversation.',
    fields: '{title?, options: [{name, value?, unit?, note?, pros?: [text], cons?: [text], lean?: boolean}] (1-6), picked? (option index)}',
    schema: block('compare', 'Options side by side for a decision the person makes; lean marks the one you recommend, picked is the index of the one they chose.', {
      title,
      options: list(object({
        name: title, value: str(LIMITS.value), unit: str(LIMITS.unit), note: str(LIMITS.line),
        pros: list(str(LIMITS.title), LIMITS.compareLines), cons: list(str(LIMITS.title), LIMITS.compareLines), lean: { type: 'boolean' },
      }, ['name']), LIMITS.compareOptions, 1),
      picked: { type: 'integer', minimum: 0, maximum: LIMITS.compareOptions - 1 },
    }, ['options']),
    example: { type: 'compare', title: 'Where to stay', options: [
      { name: 'Hotel Kanra', value: '¥32,000', unit: '/ night', pros: ['8 minutes from Kyoto Station', 'Bath and breakfast'], cons: ['¥3,500 more'], lean: true },
      { name: 'Ace Hotel', value: '¥28,500', unit: '/ night', pros: ['3 minutes from Karasuma'], cons: ['No bath', 'No breakfast'] },
      { name: 'Mitsui Garden', value: '¥30,000', unit: '/ night', pros: ['1 minute from Shijo'], cons: ['Small rooms'] },
    ] },
    title: own,
    text: (b) => lines(b.title, ...b.options.map((option, index) => [
      option.name,
      option.value ? ` — ${option.value}${option.unit ? ` ${option.unit}` : ''}` : '',
      option.note ? ` — ${option.note}` : '',
      option.pros?.length ? ` (+ ${option.pros.join('; ')})` : '',
      option.cons?.length ? ` (− ${option.cons.join('; ')})` : '',
      b.picked === index ? ' (picked)' : option.lean ? ' (recommended)' : '',
    ].join(''))),
  },
  conflict: {
    type: 'conflict', label: 'Conflict', category: 'decisions',
    blurb: 'Two conversations disagree. Keep the version that is right.',
    describe: 'Conversations say different things about one question: each version with where it came from (from: the app or conversation, at: when, nodeId: that conversation of this workspace). '
      + 'The person keeps one (resolution: its index) or both ("both").',
    fields: '{question, options: [{text, from?, at?: epoch ms or ISO 8601 date/date-time, nodeId? (a real conversation of this workspace)}] (2-6), resolution?: option index | "both"}',
    schema: block('conflict', 'Conversations say different things about one question; the person keeps one version (resolution: its index) or both.', {
      question: str(LIMITS.line),
      options: list(object({ text: str(LIMITS.line), from: str(LIMITS.value), at, nodeId: id }, ['text']), LIMITS.conflictOptions, 2),
      resolution: { anyOf: [{ type: 'integer', minimum: 0, maximum: LIMITS.conflictOptions - 1 }, { type: 'string', enum: ['both'] }] },
    }, ['question', 'options']),
    example: { type: 'conflict', question: 'Where do we go on November 3?', options: [
      { text: 'Arashiyama and the Sagano scenic railway', from: 'Kiro', at: '2026-10-14' },
      { text: 'A day trip to Nara', from: 'Claude Code', at: '2026-10-17' },
    ] },
    title: (b) => b.question.trim(),
    text: (b) => lines(b.question, ...b.options.map((option, index) => {
      const where = [option.from, option.at === undefined ? '' : atText(option.at)].filter(Boolean).join(', ');
      return `- ${option.text}${where ? ` (${where})` : ''}${b.resolution === index ? ' (kept)' : ''}`;
    }), b.resolution === 'both' ? 'Both stand' : ''),
  },
  table: {
    type: 'table', label: 'Table', category: 'data',
    blurb: 'A small table of text.',
    describe: 'A small plain-text table: every row has one cell per column, in the columns\' order. Use a database for rows the person will sort, filter or edit.',
    fields: '{title?, columns: [text] (1-8), rows: [[text, one per column]] (at most 50)}',
    schema: block('table', 'A small plain-text table: every row has one cell per column, in the columns\' order.', {
      title, columns: list(str(LIMITS.tableHeader), LIMITS.tableColumns, 1), rows: list(list(str(LIMITS.cell), LIMITS.tableColumns, 1), LIMITS.tableRows),
    }, ['columns', 'rows']),
    example: { type: 'table', title: 'Itinerary', columns: ['Day', 'Plan', 'Stay'], rows: [['Nov 2', 'Arrive, Nishiki Market', 'Hotel Kanra'], ['Nov 3', 'Arashiyama', 'Hotel Kanra'], ['Nov 4', 'Nara day trip', 'Hotel Kanra']] },
    title: own,
    text: (b) => lines(b.title, b.columns.join(' | '), ...b.rows.map((row) => row.join(' | '))),
  },
  criteria: {
    type: 'criteria', label: 'Success criteria', category: 'data',
    blurb: 'What success means, and where each criterion stands now.',
    describe: 'Success criteria and where each stands: state done, in-progress, stalled or not-started; now is a figure such as "6 / 11"; from says where that figure comes from. '
      + 'Write criteria only where the goal is stated in what you read.',
    fields: '{title?, items: [{text, state: done|in-progress|stalled|not-started, now?, from?}]} (at most 20)',
    schema: block('criteria', 'Success criteria and where each stands; now is a figure such as "6 / 11", from where that figure comes from.', {
      title, items: list(object({ text: str(LIMITS.title), state: { type: 'string', enum: [...CRITERION_STATES] }, now: str(LIMITS.value), from: str(LIMITS.title) }, ['text', 'state']), LIMITS.criteriaItems),
    }, ['items']),
    example: { type: 'criteria', items: [
      { text: 'All 11 sessions merged into main', state: 'in-progress', now: '6 / 11', from: 'git · main' },
      { text: 'End-to-end tests green', state: 'stalled', now: '41 / 50', from: 'S7 · last run' },
      { text: 'Old MCP config removed', state: 'not-started', from: 'plan.md' },
      { text: 'Docs updated', state: 'done', from: 'S2' },
    ] },
    title: own,
    text: (b) => lines(b.title || 'Success criteria', ...b.items.map((item) => `${item.text}: ${CRITERION_WORDS[item.state]}${item.now ? ` ${item.now}` : ''}${item.from ? ` (${item.from})` : ''}`)),
  },
  chart: {
    type: 'chart', label: 'Chart', category: 'data',
    blurb: 'Twelve chart designs, including bars, lines, pies and heatmaps.',
    describe: 'Chart kind chooses the data: bar/line/area/composite use series with points; pie uses slices; scatter/bubble use numeric x/y; radar uses axes and values; heatmap uses days; funnel uses steps; sparkline uses values; sankey uses nodes and links. Existing bar/line charts with labels and series values remain supported.',
    fields: '{title, kind: bar|line|area|composite|pie|scatter|bubble|radar|heatmap|funnel|sparkline|sankey, ...kind-specific data}; legacy: {title, kind: bar|line, labels: [text], series: [{label, values: [number ≥ 0, one per label]}], stacked?, unit?}',
    schema: { type: 'object', properties: { type: { type: 'string', enum: ['chart'] } }, anyOf: [richBlockJsonSchema(richChartSchema), block('chart', 'A simple bar or line chart: labels along the bottom and up to 3 series, each with one value per label; stacked stacks the bars.', {
      title, kind: { type: 'string', enum: [...CHART_KINDS] }, labels: list(str(LIMITS.chartLabel), LIMITS.chartLabels, 1),
      series: list(object({ label: str(LIMITS.value), values: list(amount, LIMITS.chartLabels, 1) }, ['label', 'values']), LIMITS.chartSeries, 1),
      stacked: { type: 'boolean', description: 'Bar charts only.' }, unit: str(LIMITS.unit),
    }, ['title', 'kind', 'labels', 'series'])] },
    example: { type: 'chart', title: 'Turns per day', kind: 'bar', stacked: true, labels: ['14', '15', '16', '17', '18', '19', '20'], series: [
      { label: 'KiroCrew', values: [38, 52, 61, 12, 5, 30, 44] },
      { label: 'Claude Code', values: [10, 8, 14, 4, 0, 20, 6] },
    ] },
    title: (b) => b.title.trim(),
    text: (b) => !('labels' in b) ? richContentText(b) : lines(b.title, ...b.series.map((series) => `${series.label}: ${b.labels.map((label, index) => `${label} ${amountText(series.values[index] ?? 0, b.unit)}`).join(', ')}`)),
  },
  gallery: {
    type: 'gallery', label: 'Gallery', category: 'media',
    blurb: 'Pictures in a grid, with captions.',
    describe: 'Pictures in a grid by their https address, each with a caption. Pictures on the internet load by themselves; http addresses and ones on the local network never load and show as their address.',
    fields: '{title?, items: [{url (https), caption?, alt?}]} (1-12)',
    schema: block('gallery', 'Pictures in a grid by their https address, each with a caption; http or local-network addresses never load.', {
      title, items: list(object({ url: { type: 'string', minLength: 1, maxLength: LIMITS.url }, caption: title, alt: title }, ['url']), LIMITS.galleryItems, 1),
    }, ['items']),
    example: { type: 'gallery', items: [
      { url: 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=640&q=80', caption: 'Kiyomizu-dera at dusk', alt: 'A temple on a wooded hillside' },
      { url: 'https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=640&q=80', caption: 'Bamboo grove, Arashiyama', alt: 'A path through tall bamboo' },
      { url: 'http://example.com/map.png', caption: 'Map screenshot' },
    ] },
    title: own,
    text: (b) => lines(b.title, ...b.items.map((item) => item.caption || item.alt || item.url)),
  },
  forgot: {
    type: 'forgot', label: 'You may have forgotten', category: 'conversations',
    blurb: 'Things shipped a while ago, and things left half done.',
    describe: '"You may have forgotten", for projects that add features over time: things finished a while ago with how to use them (state shipped), '
      + 'and things left half done with where they stopped (state unfinished). at is when.',
    fields: '{title?, items: [{title, state: shipped|unfinished, at?: epoch ms or ISO 8601 date/date-time, detail? (how to use it, or where it stopped)}]} (at most 20)',
    schema: block('forgot', '"You may have forgotten": shipped things with how to use them, unfinished things with where they stopped.', {
      title, items: list(object({ title: str(LIMITS.title), state: { type: 'string', enum: [...FORGOT_STATES] }, at, detail: str(LIMITS.line) }, ['title', 'state']), LIMITS.forgotItems),
    }, ['items']),
    example: { type: 'forgot', items: [
      { title: 'Orbit layout on the Map', state: 'shipped', at: '2026-09-28', detail: 'Map → Layout → Orbit' },
      { title: 'Digest from a selection', state: 'shipped', at: '2026-10-02', detail: 'Select nodes on the Map and press D' },
      { title: 'Streamdown renderer', state: 'unfinished', detail: 'Code block highlighting is not moved over yet' },
    ] },
    title: own,
    text: (b) => lines(b.title || 'You may have forgotten', ...b.items.map((item) =>
      `${item.title} (${item.state}${item.at === undefined ? '' : ` ${atText(item.at)}`})${item.detail ? `: ${item.detail}` : ''}`)),
  },
  threads: {
    type: 'threads', label: 'Thread cards', category: 'conversations',
    blurb: 'Cards for the conversations behind this page, with their live state.',
    describe: 'Cards for conversations of this workspace, by their nodeId, drawn with their live state (waiting on you, stalled, done); a click opens one. Never invent a nodeId.',
    fields: '{title?, nodeIds: [conversation node id of this workspace] (1-20, each once)}',
    schema: block('threads', 'Cards for conversations of this workspace, by their nodeId, drawn with their live state; never invent a nodeId.', {
      title, nodeIds: { ...list(id, LIMITS.threadNodes, 1), uniqueItems: true },
    }, ['nodeIds']),
    example: { type: 'threads', title: 'Sessions', nodeIds: ['sample-schema', 'sample-migration', 'sample-tests', 'sample-docs'] },
    title: own,
    text: (b) => lines(b.title, `${b.nodeIds.length} conversation${b.nodeIds.length === 1 ? '' : 's'}`),
  },
  'database-ref': {
    type: 'database-ref', label: 'Database view', category: 'references',
    blurb: 'A view of a database of this workspace.',
    describe: 'A view of a database of this workspace, by its real id; viewId picks one of its views.',
    fields: '{databaseId, viewId?}',
    schema: block('database-ref', 'A view of a database of this workspace, by its real id; viewId picks one of its views.', { databaseId: id, viewId: id }, ['databaseId']),
    title: () => '',
    text: () => 'Database view',
  },
  'home-section': {
    type: 'home-section', label: 'Attention list', category: 'conversations',
    blurb: 'Live reminders from your conversations and page suggestions.',
    describe: 'A live Home section. Its content is computed from conversations; move or delete the block with ordinary page edits.',
    fields: '{section: waiting | stalled | done}',
    schema: block('home-section', 'Live reminders from your conversations.', { section: { type: 'string', enum: ['waiting', 'stalled', 'done'] } }, ['section']),
    example: { type: 'home-section', section: 'waiting' },
    title: b => ({ waiting: 'Waiting on you', stalled: 'Stalled', done: 'Just done' })[b.section],
    text: b => ({ waiting: 'Waiting on you', stalled: 'Stalled', done: 'Just done' })[b.section],
  },
  'task-view': {
    type: 'task-view', label: 'Task board', category: 'references',
    blurb: 'This workspace’s tasks and the conversations behind them.',
    describe: 'The workspace task database with every database view; viewId opens one of its views (its Board when unset). It may sit inside a grid, columns, tabs or toggle.',
    fields: '{viewId?, title?}',
    schema: block('task-view', 'The workspace task database; viewId opens one of its views (its Board when unset). It may sit inside a container.', { viewId: id, title }, []),
    title: own,
    text: (b) => b.title?.trim() || 'Task board',
  },
  'page-link': {
    type: 'page-link', label: 'Page link', category: 'references',
    blurb: 'A link to another page.',
    describe: 'A link to another page of this workspace, by its real id.',
    fields: '{pageId}',
    schema: block('page-link', 'A link to another page of this workspace, by its real id.', { pageId: id }, ['pageId']),
    title: () => '',
    text: () => 'Page link',
  },
  component: {
    type: 'component', label: 'Workspace component', category: 'references',
    blurb: 'A component saved in this workspace, running in a sandbox.',
    describe: 'A saved workspace component: sandboxed HTML and JS from the component library, with its props. Use one only when no other block fits.',
    fields: '{componentId, pinnedVersion?, props, height?}',
    schema: block('component', 'A saved workspace component: sandboxed HTML and JS from the component library, with its props. Use one only when no other block fits.', {
      componentId: id, pinnedVersion: { type: 'integer', minimum: 1 }, props: { type: 'object' }, height: { type: 'integer', minimum: 80, maximum: 1600 },
    }, ['componentId', 'props']),
    title: () => '',
    text: (b) => `Component ${b.componentId}${b.pinnedVersion ? ` v${b.pinnedVersion}` : ''}`,
  },
  ...RICH_BLOCK_CATALOG,
  toggle: {
    type: 'toggle', label: 'Toggle', category: 'text', blurb: 'Details that start folded away.',
    describe: 'A collapsed section of content blocks. Containers nest at most 2 levels; resources and conversation references stay top-level.',
    fields: '{title, blocks: [content block]} (at most 20 children)',
    schema: block('toggle', 'A collapsed content group; nested blocks have the same validation as top-level content.', { title, blocks: { type: 'array', maxItems: 20, items: { type: 'object', description: 'A content block; no server metadata, resources or conversation references.' } } }, ['title', 'blocks']),
    example: { type: 'toggle', title: 'Details', blocks: [{ type: 'markdown', text: 'More context when you need it.' }] },
    title: own, text: (b) => lines(b.title, ...b.blocks.map(pageBlockText)),
  },
  columns: {
    type: 'columns', label: 'Columns', category: 'text', blurb: 'Content side by side.',
    describe: '2 to 4 columns of content blocks, at most 20 per column and 2 container levels. Resources and conversation references stay top-level.',
    fields: '{columns: [[content block]]}',
    schema: block('columns', 'Side-by-side content groups.', { columns: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'array', maxItems: 20, items: { type: 'object' } } } }, ['columns']),
    example: { type: 'columns', columns: [[{ type: 'markdown', text: 'Plan' }], [{ type: 'markdown', text: 'Actual' }]] },
    title: () => '', text: (b) => b.columns.flat().map(pageBlockText).join('\n'),
  },
  grid: {
    type: 'grid', label: 'Responsive grid', category: 'text', blurb: 'Arrange content in resizable regions that stack on a small screen.',
    describe: 'A responsive 12-column grid with 1 to 12 stable-id regions in reading order. span sets desktop width, tabletSpan sets medium-pane width (defaults to 12), and small panes stack every region at full width. Keep region IDs unchanged on edits. Each region holds at most 20 content blocks; containers nest at most 2 levels and resource or conversation references stay top-level.',
    fields: '{regions: [{id (unique and stable), span: 1..12, tabletSpan?: 1..12, title?, blocks: [content block]}]} (1-12 regions, at most 20 children per region)',
    schema: block('grid', 'Responsive 12-column content grid. Keep every region id stable; small panes stack all regions. Resources and conversation references stay top-level.', {
      regions: list(object({ id, span: { type: 'integer', minimum: 1, maximum: 12 }, tabletSpan: { type: 'integer', minimum: 1, maximum: 12 }, title,
        blocks: list({ type: 'object', description: 'A content block; no server metadata, resources or conversation references.' }, 20),
      }, ['id', 'span', 'blocks']), 12, 1),
    }, ['regions']),
    example: { type: 'grid', regions: [
      { id: 'main', title: 'Current work', span: 8, blocks: [{ type: 'markdown', text: 'Keep the main details here.' }] },
      { id: 'attention', title: 'Needs attention', span: 4, blocks: [{ type: 'checklist', items: [{ text: 'Review the next step', done: false }] }] },
    ] },
    title: () => '', text: (b) => b.regions.map((region) => lines(region.title, ...region.blocks.map(pageBlockText))).join('\n'),
  },
  tabs: {
    type: 'tabs', label: 'Tabs', category: 'text', blurb: 'Switch between related sections.',
    describe: '2 to 6 named tabs of content blocks, at most 20 per tab and 2 container levels. Resources and conversation references stay top-level.',
    fields: '{tabs: [{label, blocks: [content block]}]}',
    schema: block('tabs', 'Tabbed content groups.', { tabs: { type: 'array', minItems: 2, maxItems: 6, items: object({ label: title, blocks: { type: 'array', maxItems: 20, items: { type: 'object' } } }, ['label', 'blocks']) } }, ['tabs']),
    example: { type: 'tabs', tabs: [{ label: 'Plan', blocks: [{ type: 'markdown', text: 'What we planned.' }] }, { label: 'Actual', blocks: [{ type: 'markdown', text: 'Where we are.' }] }] },
    title: () => '', text: (b) => b.tabs.map((tab) => lines(tab.label, ...tab.blocks.map(pageBlockText))).join('\n'),
  },
  view: {
    type: 'view', label: 'Named view', category: 'references', blurb: 'Compose extra information from existing page blocks.',
    describe: 'An optional named view, opened by view-link, a block interaction, a metric action or Markdown [label](#view/name). blockIds are real top-level block IDs from this page, in display order; they may include text, containers, charts, task views, database references and components, but not view definitions. Save content first and read its assigned IDs. Set visibility:"detail" on content that should only appear when opened; omit it to also show content on the page. Opening is local and does not run an agent. Static pages are equally valid.',
    fields: '{viewId (stable page-local name), title, blockIds: [existing content block ID]}',
    schema: block('view', 'A named view referencing existing page content. No extra content store or permissions.', { viewId, title: { ...title, minLength: 1 }, blockIds: { ...list(id, 40, 1), uniqueItems: true } }, ['viewId', 'title', 'blockIds']),
    title: own, text: b => b.title,
  },
  'view-link': {
    type: 'view-link', label: 'View link', category: 'references', blurb: 'Open an explanation, comparison, visualization or live data view.',
    describe: 'An optional text link to a named view in this page. action is {type:"open-view",viewId,presentation?:inline|drawer|modal}; drawer is the default. Inline expands below the entry; drawer keeps the page usable; modal opens a dialog. Choose when it helps the current activity; no mandatory drill-down or task-page structure.',
    fields: '{label, action: {type:"open-view", viewId, presentation?: inline|drawer|modal}}',
    schema: block('view-link', 'Open agent-composed information on this page.', { label: { ...title, minLength: 1 }, action: viewAction }, ['label', 'action']),
    title: b => b.label, text: b => b.label,
  },
};

/** Every block type, in the order tools list them. */
export const PAGE_BLOCK_TYPES = Object.keys(PAGE_BLOCK_CATALOG) as PageBlockType[];

/** Decorate every root schema, including rich chart alternatives, without loosening its closed fields. */
function withInteraction(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  if (schema.properties) result.properties = { ...(schema.properties as Record<string, unknown>), interaction, visibility: { const: 'detail', description: 'Top-level content only: render this block only inside a named view.' } };
  for (const key of ['oneOf', 'anyOf']) if (Array.isArray(schema[key])) result[key] = (schema[key] as Record<string, unknown>[]).map(withInteraction);
  return result;
}
for (const type of PAGE_BLOCK_TYPES) if (type !== 'view') PAGE_BLOCK_CATALOG[type].schema = withInteraction(PAGE_BLOCK_CATALOG[type].schema);

export function pageBlockEntry<T extends PageBlockType>(type: T): PageBlockCatalogEntry<T> {
  return PAGE_BLOCK_CATALOG[type] as PageBlockCatalogEntry<T>;
}

type AnyEntry = PageBlockCatalogEntry<PageBlockType> & { title(block: PageBlockInput): string; text(block: PageBlockInput): string };

/** A block's entry; none for a type this build does not know (a newer backend's), or a key that is not a type. */
const entryOf = (block: PageBlockInput): AnyEntry | undefined => (
  Object.prototype.hasOwnProperty.call(PAGE_BLOCK_CATALOG, block.type) ? PAGE_BLOCK_CATALOG[block.type] as unknown as AnyEntry : undefined
);

/** A block's own title, '' when it has none. */
export function pageBlockTitle(block: PageBlockInput): string {
  return entryOf(block)?.title(block) ?? '';
}

/** A block as plain text, one fact per line; '' for a type this build does not know. */
export function pageBlockText(block: PageBlockInput): string {
  return entryOf(block)?.text(block) ?? '';
}

/** The JSON Schema of a block's content, one branch per type, as page-writing tools take it. */
export function pageBlockInputSchema(): { oneOf: Array<Record<string, unknown>> } {
  return { oneOf: PAGE_BLOCK_TYPES.map((type) => PAGE_BLOCK_CATALOG[type].schema) };
}

/** Every block's content in brief, for a tool description: `heading {text}; markdown {text}; …`. */
export function pageBlockFieldsDoc(): string {
  return PAGE_BLOCK_TYPES.map((type) => `${type} ${PAGE_BLOCK_CATALOG[type].fields}`).join('; ')
    + '. Optional on any content block: interaction:{label,action:{type:"open-view",viewId,presentation?:inline|drawer|modal}} adds a view entry. Top-level visibility:"detail" keeps content off the main page until opened. Named views reference real blockIds; create content first, then views and entries. Use these capabilities only when helpful; static summaries, comparisons and visualizations remain valid';
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Why a block's content is not valid, in words for the agent that wrote it:
 * an unknown type, fields the type has not got or is missing, else the
 * type's fields and rules. '' when it is valid.
 */
export function pageBlockProblem(value: unknown): string {
  if (parsePageBlockInput(value)) return '';
  if (!isObject(value)) return 'A block is an object with a type';
  const type = value.type;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(PAGE_BLOCK_CATALOG, type)) {
    return `Unknown block type ${JSON.stringify(type) ?? 'undefined'}; the types are ${PAGE_BLOCK_TYPES.join(', ')}`;
  }
  const entry = PAGE_BLOCK_CATALOG[type as PageBlockType];
  type InputSchema = { properties?: Record<string, { const?: unknown; enum?: unknown[] }>; required?: string[]; anyOf?: InputSchema[] };
  let schema = entry.schema as InputSchema;
  if (type === 'chart' && schema.anyOf) {
    schema = 'labels' in value ? schema.anyOf[1] : schema.anyOf[0].anyOf?.find((candidate) => {
      const kind = candidate.properties?.kind;
      return kind?.const === value.kind || kind?.enum?.includes(value.kind);
    }) ?? schema;
  }
  if (!schema.properties) return `This ${type} block breaks a rule of its fields: ${entry.fields}`;
  const unknown = Object.keys(value).filter((key) => !Object.prototype.hasOwnProperty.call(schema.properties!, key));
  if (unknown.length) return `A ${type} block has no ${unknown.join(', ')}. Its fields: ${entry.fields}`;
  const missing = (schema.required ?? []).filter((key) => value[key] === undefined);
  if (missing.length) return `A ${type} block needs ${missing.join(', ')}. Its fields: ${entry.fields}`;
  return `This ${type} block breaks a rule of its fields: ${entry.fields}`;
}
