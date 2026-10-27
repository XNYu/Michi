/** Browser-safe native page block contracts and validators. */
import { parseRichBlock, richChartSchema, type RichBlockContent, type RichChart } from './richBlocks';
import { validatePageComponentProps } from './components';
import { parsePageSegmentSources, type PageSegmentSources } from './markdownSegments';
export interface BlockSource {
  nodeId: string;
  turnId: string;
  assistantId: string;
}

export interface BlockEdit {
  at: number;
}

/** Status tones shared by callouts and timeline entries. */
export type BlockTone = 'info' | 'success' | 'warn' | 'danger';
export const BLOCK_TONES: readonly BlockTone[] = ['info', 'success', 'warn', 'danger'];
export type MetricTone = 'default' | 'accent';
export const METRIC_TONES: readonly MetricTone[] = ['default', 'accent'];
export type NextStepWho = 'user' | 'agent';
export const NEXT_STEP_WHO: readonly NextStepWho[] = ['user', 'agent'];

export interface MetricItem { label: string; value: string; tone?: MetricTone; note?: string }
export interface NextStepItem { who: NextStepWho; text: string; unblocks?: string }
/** `at` is epoch milliseconds or an ISO 8601 date or date-time. */
export interface TimelineItem { title: string; at: number | string; detail?: string; tone?: BlockTone }

/** One row of a plan-actual block measured in an amount: a budget, hours, tasks. */
export interface PlanActualAmount { label: string; planned: number; actual: number; forecast?: number; unit?: string }
/**
 * One phase of a plan-actual block measured in days (YYYY-MM-DD, both ends
 * counted). No actualStart: not started; actualStart alone: still under way,
 * running to today. A forecast says when it should start and end from here.
 */
export interface PlanActualSpan {
  label: string; planStart: string; planEnd: string;
  actualStart?: string; actualEnd?: string; forecastStart?: string; forecastEnd?: string;
}
/** A compare option; `lean` marks the one the agent leans to, the block's `picked` the one the person chose. */
export interface CompareOption { name: string; value?: string; unit?: string; note?: string; pros?: string[]; cons?: string[]; lean?: boolean }
/** What one conversation says about the question: `from` names the app or conversation, `nodeId` opens it. */
export interface ConflictOption { text: string; from?: string; at?: number | string; nodeId?: string }
export type CriterionState = 'done' | 'in-progress' | 'stalled' | 'not-started';
export const CRITERION_STATES: readonly CriterionState[] = ['done', 'in-progress', 'stalled', 'not-started'];
/** A success criterion: where it stands now (`now`, a figure such as "6 / 11") and where that figure comes from. */
export interface CriterionItem { text: string; state: CriterionState; now?: string; from?: string }
export type ChartKind = 'bar' | 'line';
export const CHART_KINDS: readonly ChartKind[] = ['bar', 'line'];
/** One value per label of its chart, in the labels' order. */
export interface ChartSeries { label: string; values: number[] }
/** An http(s) picture; only https ones load. */
export interface GalleryImage { url: string; caption?: string; alt?: string }
export type ForgotState = 'shipped' | 'unfinished';
export const FORGOT_STATES: readonly ForgotState[] = ['shipped', 'unfinished'];
/** Something done a while ago worth a reminder: how to use it once shipped, where it stopped when unfinished. */
export interface ForgotItem { title: string; state: ForgotState; at?: number | string; detail?: string }

/** Field and item bounds of the structured blocks; tool schemas state the same numbers. */
export const PAGE_BLOCK_LIMITS = {
  text: 2_000, title: 200, line: 500, value: 100, at: 40,
  checklistItems: 50, metricsItems: 12, nextStepsItems: 20, timelineItems: 50,
  unit: 40, amount: 1e15, planActualItems: 20, compareOptions: 6, compareLines: 6, conflictOptions: 6,
  tableColumns: 8, tableRows: 50, tableHeader: 100, cell: 500, criteriaItems: 20,
  chartSeries: 3, chartLabels: 31, chartLabel: 40, galleryItems: 12, url: 2_000, forgotItems: 20, threadNodes: 20,
} as const;

interface HeadingBlock { type: 'heading'; text: string }
interface MarkdownBlock { type: 'markdown'; text: string; segmentSources?: PageSegmentSources[] }
interface CalloutBlock { type: 'callout'; text: string; title?: string; tone?: BlockTone }
interface ChecklistBlock { type: 'checklist'; title?: string; items: Array<{ text: string; done: boolean }> }
interface MetricsBlock { type: 'metrics'; items: MetricItem[] }
interface NextStepsBlock { type: 'next-steps'; title?: string; items: NextStepItem[] }
interface TimelineBlock { type: 'timeline'; title?: string; items: TimelineItem[] }
interface DatabaseRefBlock { type: 'database-ref'; databaseId: string; viewId?: string }
interface PageLinkBlock { type: 'page-link'; pageId: string }
/** A native library component mounted in a page block. A missing pin follows the active library version. */
interface ComponentBlock { type: 'component'; componentId: string; pinnedVersion?: number; props: Record<string, unknown>; height?: number }
/** Every item in amounts or every item in days; `today` places today on an amount scale. */
interface PlanActualBlock { type: 'plan-actual'; title?: string; items: PlanActualAmount[] | PlanActualSpan[]; today?: number }
/** `picked` is the index of the option the person chose. */
interface CompareBlock { type: 'compare'; title?: string; options: CompareOption[]; picked?: number }
/** Two conversations disagree; `resolution` is the index of the option kept, or `both` when both stand. */
interface ConflictBlock { type: 'conflict'; question: string; options: ConflictOption[]; resolution?: number | 'both' }
/** Plain text cells, each row as long as the columns. */
interface TableBlock { type: 'table'; title?: string; columns: string[]; rows: string[][] }
interface CriteriaBlock { type: 'criteria'; title?: string; items: CriterionItem[] }
/** Bars (stacked when `stacked`) or lines over `labels`. */
interface ChartBlock { type: 'chart'; title: string; kind: ChartKind; labels: string[]; series: ChartSeries[]; stacked?: boolean; unit?: string }
interface GalleryBlock { type: 'gallery'; title?: string; items: GalleryImage[] }
interface ForgotBlock { type: 'forgot'; title?: string; items: ForgotItem[] }
/** Cards for conversations of the page's workspace, drawn with their live state. */
interface ThreadsBlock { type: 'threads'; title?: string; nodeIds: string[] }
/**
 * The workspace's task database, drawn with every database feature; `viewId`
 * is the view it opens on (its Board when unset). It names no database, so it
 * is no resource reference and may sit inside a container.
 */
interface HomeSectionBlock { type: 'home-section'; section: 'waiting' | 'stalled' | 'done' }
interface TaskViewBlock { type: 'task-view'; viewId?: string; title?: string }

/** Containers are content groups, saved and versioned as one top-level block.
 * Resource references stay top-level so their identity, ownership and history remain explicit. */
export type NestedPageBlock = Exclude<PageBlockContent, DatabaseRefBlock | PageLinkBlock | ComponentBlock | ThreadsBlock | ConflictBlock | HomeSectionBlock>;
/** A region keeps its identity when the person changes its width or reading order. */
export interface PageGridRegion { id: string; span: number; tabletSpan?: number; title?: string; blocks: NestedPageBlock[] }
export type ContainerBlock = { type: 'toggle'; title: string; blocks: NestedPageBlock[] }
  | { type: 'columns'; columns: NestedPageBlock[][] }
  | { type: 'tabs'; tabs: Array<{ label: string; blocks: NestedPageBlock[] }> }
  | { type: 'grid'; regions: PageGridRegion[] };

export type PageBlockContent = RichBlockContent | RichChart | ContainerBlock | HeadingBlock | MarkdownBlock | CalloutBlock | ChecklistBlock | MetricsBlock | NextStepsBlock | TimelineBlock
  | DatabaseRefBlock | PageLinkBlock | ComponentBlock | TaskViewBlock | HomeSectionBlock
  | PlanActualBlock | CompareBlock | ConflictBlock | TableBlock | CriteriaBlock | ChartBlock | GalleryBlock | ForgotBlock | ThreadsBlock;
export type PageBlockInput = PageBlockContent;
export type PageBlock = PageBlockContent & { id: string; rev: number; sources?: BlockSource[]; edit?: BlockEdit };
export type PageBlockWithSources = PageBlock;

const MAX_TEXT: number = PAGE_BLOCK_LIMITS.text;
const MAX_TITLE: number = PAGE_BLOCK_LIMITS.title;
const MAX_ID = 200;
const MAX_SOURCES = 100;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;
}

function validText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.length <= max;
}

const ISO_AT = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?)?$/;

/** The latest moment a JavaScript date holds; a later epoch has no date to show. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** Epoch milliseconds a date can hold, or an ISO 8601 date or date-time that names a real day. */
export function isTimelineAt(value: unknown): value is number | string {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH_MS;
  if (typeof value !== 'string' || value.length > PAGE_BLOCK_LIMITS.at || !ISO_AT.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day && Number.isFinite(Date.parse(value));
}

function optional(value: unknown, valid: (entry: unknown) => boolean): boolean {
  return value === undefined || valid(value);
}

const oneOf = <T extends string>(allowed: readonly T[]) => (value: unknown): value is T => allowed.includes(value as T);

function present<T>(value: Record<string, unknown>, keys: readonly (keyof T & string)[]): Partial<T> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) as Partial<T>;
}

function parseItems<T>(value: unknown, max: number, parse: (item: Record<string, unknown>) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const items: T[] = [];
  for (const raw of value) {
    const item = isRecord(raw) ? parse(raw) : null;
    if (!item) return null;
    items.push(item);
  }
  return items;
}

function parseMetric(item: Record<string, unknown>): MetricItem | null {
  if (!exactKeys(item, ['label', 'value', 'tone', 'note']) || !validText(item.label, MAX_TITLE) || !validText(item.value, PAGE_BLOCK_LIMITS.value) ||
    !optional(item.tone, oneOf(METRIC_TONES)) || !optional(item.note, (note) => validText(note, MAX_TITLE))) return null;
  return { label: item.label, value: item.value, ...present<MetricItem>(item, ['tone', 'note']) };
}

function parseNextStep(item: Record<string, unknown>): NextStepItem | null {
  if (!exactKeys(item, ['who', 'text', 'unblocks']) || !oneOf(NEXT_STEP_WHO)(item.who) || !validText(item.text, PAGE_BLOCK_LIMITS.line) ||
    !optional(item.unblocks, (unblocks) => validText(unblocks, MAX_TITLE))) return null;
  return { who: item.who, text: item.text, ...present<NextStepItem>(item, ['unblocks']) };
}

function parseTimelineItem(item: Record<string, unknown>): TimelineItem | null {
  if (!exactKeys(item, ['title', 'at', 'detail', 'tone']) || !validText(item.title, MAX_TITLE) || !isTimelineAt(item.at) ||
    !optional(item.detail, (detail) => validText(detail, PAGE_BLOCK_LIMITS.line)) || !optional(item.tone, oneOf(BLOCK_TONES))) return null;
  return { title: item.title, at: item.at, ...present<TimelineItem>(item, ['detail', 'tone']) };
}

function titled(value: Record<string, unknown>): { title?: string } | null {
  if (value.title === undefined) return {};
  return validText(value.title, MAX_TITLE) ? { title: value.title } : null;
}

/** A list of min to max entries, each one `parse` accepts. */
function parseList<T>(value: unknown, min: number, max: number, parse: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > max) return null;
  const entries: T[] = [];
  for (const raw of value) {
    const entry = parse(raw);
    if (entry === null) return null;
    entries.push(entry);
  }
  return entries;
}

const record = <T>(parse: (item: Record<string, unknown>) => T | null) => (raw: unknown): T | null => (isRecord(raw) ? parse(raw) : null);
const textOf = (max: number) => (value: unknown): string | null => (validText(value, max) ? value : null);
const validIndex = (value: unknown, length: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < length;

/** A finite figure from 0 up to the amount bound. */
function validAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= PAGE_BLOCK_LIMITS.amount;
}

const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** A real day as YYYY-MM-DD. */
export function isPageDay(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** An http or https address with a host. Only https pictures load; the rest show as their link. */
export function isPageImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > PAGE_BLOCK_LIMITS.url || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '';
  } catch {
    return false;
  }
}

function parsePlanAmount(item: Record<string, unknown>): PlanActualAmount | null {
  if (!exactKeys(item, ['label', 'planned', 'actual', 'forecast', 'unit']) || !validText(item.label, MAX_TITLE) || !validAmount(item.planned) ||
    !validAmount(item.actual) || !optional(item.forecast, validAmount) || !optional(item.unit, (unit) => validText(unit, PAGE_BLOCK_LIMITS.unit))) return null;
  return { label: item.label, planned: item.planned, actual: item.actual, ...present<PlanActualAmount>(item, ['forecast', 'unit']) };
}

const SPAN_DAYS = ['planStart', 'planEnd', 'actualStart', 'actualEnd', 'forecastStart', 'forecastEnd'] as const;
/** ISO days order as text; a missing end leaves nothing to order. */
const inOrder = (from: unknown, to: unknown) => from === undefined || to === undefined || (from as string) <= (to as string);

function parsePlanSpan(item: Record<string, unknown>): PlanActualSpan | null {
  if (!exactKeys(item, ['label', ...SPAN_DAYS]) || !validText(item.label, MAX_TITLE) || !isPageDay(item.planStart) || !isPageDay(item.planEnd)) return null;
  if (!SPAN_DAYS.every((key) => optional(item[key], isPageDay))) return null;
  // An end without its start, or a forecast that starts but never ends, places nothing.
  if ((item.actualEnd !== undefined && item.actualStart === undefined) || (item.forecastStart !== undefined && item.forecastEnd === undefined)) return null;
  if (!inOrder(item.planStart, item.planEnd) || !inOrder(item.actualStart, item.actualEnd) || !inOrder(item.forecastStart, item.forecastEnd)) return null;
  return { label: item.label, planStart: item.planStart, planEnd: item.planEnd,
    ...present<PlanActualSpan>(item, ['actualStart', 'actualEnd', 'forecastStart', 'forecastEnd']) };
}

function parseCompareOption(item: Record<string, unknown>): CompareOption | null {
  if (!exactKeys(item, ['name', 'value', 'unit', 'note', 'pros', 'cons', 'lean']) || !validText(item.name, MAX_TITLE) ||
    !optional(item.value, (value) => validText(value, PAGE_BLOCK_LIMITS.value)) || !optional(item.unit, (unit) => validText(unit, PAGE_BLOCK_LIMITS.unit)) ||
    !optional(item.note, (note) => validText(note, PAGE_BLOCK_LIMITS.line)) || !optional(item.lean, (lean) => typeof lean === 'boolean')) return null;
  const lines = (value: unknown) => (value === undefined ? undefined : parseList(value, 0, PAGE_BLOCK_LIMITS.compareLines, textOf(MAX_TITLE)));
  const pros = lines(item.pros);
  const cons = lines(item.cons);
  if (pros === null || cons === null) return null;
  return { name: item.name, ...present<CompareOption>(item, ['value', 'unit', 'note', 'lean']), ...(pros ? { pros } : {}), ...(cons ? { cons } : {}) };
}

function parseConflictOption(item: Record<string, unknown>): ConflictOption | null {
  if (!exactKeys(item, ['text', 'from', 'at', 'nodeId']) || !validText(item.text, PAGE_BLOCK_LIMITS.line) ||
    !optional(item.from, (from) => validText(from, PAGE_BLOCK_LIMITS.value)) || !optional(item.at, isTimelineAt) || !optional(item.nodeId, validId)) return null;
  return { text: item.text, ...present<ConflictOption>(item, ['from', 'at', 'nodeId']) };
}

function parseCriterion(item: Record<string, unknown>): CriterionItem | null {
  if (!exactKeys(item, ['text', 'state', 'now', 'from']) || !validText(item.text, MAX_TITLE) || !oneOf(CRITERION_STATES)(item.state) ||
    !optional(item.now, (now) => validText(now, PAGE_BLOCK_LIMITS.value)) || !optional(item.from, (from) => validText(from, MAX_TITLE))) return null;
  return { text: item.text, state: item.state, ...present<CriterionItem>(item, ['now', 'from']) };
}

const chartSeries = (count: number) => record((item): ChartSeries | null => {
  if (!exactKeys(item, ['label', 'values']) || !validText(item.label, PAGE_BLOCK_LIMITS.value)) return null;
  const values = parseList(item.values, count, count, (value) => (validAmount(value) ? value : null));
  return values ? { label: item.label, values } : null;
});

function parseGalleryImage(item: Record<string, unknown>): GalleryImage | null {
  if (!exactKeys(item, ['url', 'caption', 'alt']) || !isPageImageUrl(item.url) ||
    !optional(item.caption, (caption) => validText(caption, MAX_TITLE)) || !optional(item.alt, (alt) => validText(alt, MAX_TITLE))) return null;
  return { url: item.url, ...present<GalleryImage>(item, ['caption', 'alt']) };
}

function parseForgot(item: Record<string, unknown>): ForgotItem | null {
  if (!exactKeys(item, ['title', 'state', 'at', 'detail']) || !validText(item.title, MAX_TITLE) || !oneOf(FORGOT_STATES)(item.state) ||
    !optional(item.at, isTimelineAt) || !optional(item.detail, (detail) => validText(detail, PAGE_BLOCK_LIMITS.line))) return null;
  return { title: item.title, state: item.state, ...present<ForgotItem>(item, ['at', 'detail']) };
}

export function parseBlockSource(value: unknown): BlockSource | null {
  if (!isRecord(value) || !exactKeys(value, ['nodeId', 'turnId', 'assistantId'])) return null;
  if (![value.nodeId, value.turnId, value.assistantId].every(validId)) return null;
  return { nodeId: value.nodeId as string, turnId: value.turnId as string, assistantId: value.assistantId as string };
}

/** Parses content only: metadata such as id/rev/sources/edit is deliberately rejected. */
export function parsePageBlockInput(value: unknown): PageBlockInput | null {
  return parseContent(value, 0, { left: 120 });
}

function parseContent(value: unknown, depth: number, budget: { left: number }): PageBlockInput | null {
  if (depth > 2 || budget.left-- <= 0) return null;
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'heading':
      return exactKeys(value, ['type', 'text']) && validText(value.text, MAX_TITLE)
        ? { type: 'heading', text: value.text } : null;
    case 'markdown': {
      if (!exactKeys(value, ['type', 'text', 'segmentSources']) || !validText(value.text)) return null;
      if (value.segmentSources === undefined) return { type: 'markdown', text: value.text };
      const segmentSources = parsePageSegmentSources(value.text, value.segmentSources);
      return segmentSources ? { type: 'markdown', text: value.text, segmentSources } : null;
    }
    case 'callout':
      if (!exactKeys(value, ['type', 'text', 'title', 'tone']) || !validText(value.text)) return null;
      if (value.title !== undefined && !validText(value.title, MAX_TITLE)) return null;
      if (!optional(value.tone, oneOf(BLOCK_TONES))) return null;
      return { type: 'callout', text: value.text, ...(value.title === undefined ? {} : { title: value.title as string }), ...(value.tone === undefined ? {} : { tone: value.tone as CalloutBlock['tone'] }) };
    case 'checklist':
      if (!exactKeys(value, ['type', 'title', 'items']) || !Array.isArray(value.items) || value.items.length > PAGE_BLOCK_LIMITS.checklistItems) return null;
      if (value.title !== undefined && !validText(value.title, MAX_TITLE)) return null;
      const items: ChecklistBlock['items'] = [];
      for (const item of value.items) {
        if (!isRecord(item) || !exactKeys(item, ['text', 'done']) || !validText(item.text, MAX_TITLE) || typeof item.done !== 'boolean') return null;
        items.push({ text: item.text, done: item.done });
      }
      return { type: 'checklist', ...(value.title === undefined ? {} : { title: value.title as string }), items };
    case 'metrics': {
      if (!exactKeys(value, ['type', 'items'])) return null;
      const metrics = parseItems(value.items, PAGE_BLOCK_LIMITS.metricsItems, parseMetric);
      return metrics ? { type: 'metrics', items: metrics } : null;
    }
    case 'next-steps': {
      const title = titled(value);
      if (!exactKeys(value, ['type', 'title', 'items']) || !title) return null;
      const steps = parseItems(value.items, PAGE_BLOCK_LIMITS.nextStepsItems, parseNextStep);
      return steps ? { type: 'next-steps', ...title, items: steps } : null;
    }
    case 'timeline': {
      const title = titled(value);
      if (!exactKeys(value, ['type', 'title', 'items']) || !title) return null;
      const entries = parseItems(value.items, PAGE_BLOCK_LIMITS.timelineItems, parseTimelineItem);
      return entries ? { type: 'timeline', ...title, items: entries } : null;
    }
    case 'database-ref':
      if (!exactKeys(value, ['type', 'databaseId', 'viewId']) || !validId(value.databaseId) || (value.viewId !== undefined && !validId(value.viewId))) return null;
      return { type: 'database-ref', databaseId: value.databaseId, ...(value.viewId === undefined ? {} : { viewId: value.viewId as string }) };
    case 'page-link':
      return exactKeys(value, ['type', 'pageId']) && validId(value.pageId) ? { type: 'page-link', pageId: value.pageId } : null;
    case 'component': {
      if (!exactKeys(value, ['type', 'componentId', 'pinnedVersion', 'props', 'height']) || !validId(value.componentId) ||
        (value.pinnedVersion !== undefined && (!Number.isSafeInteger(value.pinnedVersion) || (value.pinnedVersion as number) < 1)) ||
        (value.height !== undefined && (!Number.isSafeInteger(value.height) || (value.height as number) < 80 || (value.height as number) > 1600))) return null;
      const props = validatePageComponentProps(null, value.props);
      return props === null ? null : { type: 'component', componentId: value.componentId,
        ...(value.pinnedVersion === undefined ? {} : { pinnedVersion: value.pinnedVersion as number }), props,
        ...(value.height === undefined ? {} : { height: value.height as number }) };
    }
    case 'plan-actual': {
      const title = titled(value);
      if (!exactKeys(value, ['type', 'title', 'items', 'today']) || !title || !Array.isArray(value.items) || value.items.length === 0) return null;
      // The first item says which measure the block uses; every other item has to use the same one.
      const spans = isRecord(value.items[0]) && value.items[0].planStart !== undefined;
      const items = spans
        ? parseItems(value.items, PAGE_BLOCK_LIMITS.planActualItems, parsePlanSpan)
        : parseItems(value.items, PAGE_BLOCK_LIMITS.planActualItems, parsePlanAmount);
      if (!items || (value.today !== undefined && (spans || !validAmount(value.today)))) return null;
      return { type: 'plan-actual', ...title, items, ...(value.today === undefined ? {} : { today: value.today as number }) } as PlanActualBlock;
    }
    case 'compare': {
      const title = titled(value);
      if (!exactKeys(value, ['type', 'title', 'options', 'picked']) || !title) return null;
      const options = parseList(value.options, 1, PAGE_BLOCK_LIMITS.compareOptions, record(parseCompareOption));
      if (!options || !optional(value.picked, (picked) => validIndex(picked, options.length))) return null;
      return { type: 'compare', ...title, options, ...(value.picked === undefined ? {} : { picked: value.picked as number }) };
    }
    case 'conflict': {
      if (!exactKeys(value, ['type', 'question', 'options', 'resolution']) || !validText(value.question, PAGE_BLOCK_LIMITS.line)) return null;
      const options = parseList(value.options, 2, PAGE_BLOCK_LIMITS.conflictOptions, record(parseConflictOption));
      if (!options || !optional(value.resolution, (kept) => kept === 'both' || validIndex(kept, options.length))) return null;
      return { type: 'conflict', question: value.question, options, ...(value.resolution === undefined ? {} : { resolution: value.resolution as number | 'both' }) };
    }
    case 'table': {
      const title = titled(value);
      if (!exactKeys(value, ['type', 'title', 'columns', 'rows']) || !title) return null;
      const columns = parseList(value.columns, 1, PAGE_BLOCK_LIMITS.tableColumns, textOf(PAGE_BLOCK_LIMITS.tableHeader));
      if (!columns) return null;
      const rows = parseList(value.rows, 0, PAGE_BLOCK_LIMITS.tableRows, (row) => parseList(row, columns.length, columns.length, textOf(PAGE_BLOCK_LIMITS.cell)));
      return rows ? { type: 'table', ...title, columns, rows } : null;
    }
    case 'criteria': {
      const title = titled(value);
      if (!exactKeys(value, ['type', 'title', 'items']) || !title) return null;
      const criteria = parseItems(value.items, PAGE_BLOCK_LIMITS.criteriaItems, parseCriterion);
      return criteria ? { type: 'criteria', ...title, items: criteria } : null;
    }
    case 'chart': {
      if (!('labels' in value)) { const parsed = richChartSchema.safeParse(value); return parsed.success ? parsed.data : null; }
      if (!exactKeys(value, ['type', 'title', 'kind', 'labels', 'series', 'stacked', 'unit']) || !validText(value.title, MAX_TITLE) || !oneOf(CHART_KINDS)(value.kind) ||
        // Only bars stack; a line chart may still say it does not.
        !optional(value.stacked, (stacked) => typeof stacked === 'boolean' && (!stacked || value.kind === 'bar')) || !optional(value.unit, (unit) => validText(unit, PAGE_BLOCK_LIMITS.unit))) return null;
      const labels = parseList(value.labels, 1, PAGE_BLOCK_LIMITS.chartLabels, textOf(PAGE_BLOCK_LIMITS.chartLabel));
      const series = labels && parseList(value.series, 1, PAGE_BLOCK_LIMITS.chartSeries, chartSeries(labels.length));
      return labels && series ? { type: 'chart', title: value.title, kind: value.kind, labels, series, ...present<ChartBlock>(value, ['stacked', 'unit']) } : null;
    }
    case 'gallery': {
      const title = titled(value);
      if (!exactKeys(value, ['type', 'title', 'items']) || !title) return null;
      const images = parseList(value.items, 1, PAGE_BLOCK_LIMITS.galleryItems, record(parseGalleryImage));
      return images ? { type: 'gallery', ...title, items: images } : null;
    }
    case 'forgot': {
      const title = titled(value);
      if (!exactKeys(value, ['type', 'title', 'items']) || !title) return null;
      const forgotten = parseItems(value.items, PAGE_BLOCK_LIMITS.forgotItems, parseForgot);
      return forgotten ? { type: 'forgot', ...title, items: forgotten } : null;
    }
    case 'threads': {
      const title = titled(value);
      if (!exactKeys(value, ['type', 'title', 'nodeIds']) || !title) return null;
      const nodeIds = parseList(value.nodeIds, 1, PAGE_BLOCK_LIMITS.threadNodes, (id) => (validId(id) ? id : null));
      return nodeIds && new Set(nodeIds).size === nodeIds.length ? { type: 'threads', ...title, nodeIds } : null;
    }
    case 'home-section': {
      if (!exactKeys(value, ['type', 'section']) || !['waiting', 'stalled', 'done'].includes(value.section as string)) return null;
      return { type: 'home-section', section: value.section as HomeSectionBlock['section'] };
    }
    case 'task-view': {
      const title = titled(value);
      if (!exactKeys(value, ['type', 'viewId', 'title']) || !title || !optional(value.viewId, validId)) return null;
      return { type: 'task-view', ...(value.viewId === undefined ? {} : { viewId: value.viewId as string }), ...title };
    }
    case 'toggle':
    case 'columns':
    case 'tabs':
    case 'grid': {
      const slot = (raw: unknown): NestedPageBlock[] | null => {
        if (!Array.isArray(raw) || raw.length > 20) return null;
        const parsed = raw.map((child) => parseContent(child, depth + 1, budget));
        const references = new Set(['database-ref', 'page-link', 'component', 'threads', 'conflict', 'home-section']);
        return parsed.every((child) => child && !references.has(child.type)) ? parsed as NestedPageBlock[] : null;
      };
      if (value.type === 'toggle') {
        if (!exactKeys(value, ['type', 'title', 'blocks']) || !validText(value.title, MAX_TITLE)) return null;
        const blocks = slot(value.blocks);
        return blocks ? { type: 'toggle', title: value.title, blocks } : null;
      }
      if (value.type === 'columns') {
        if (!exactKeys(value, ['type', 'columns'])) return null;
        const columns = parseList(value.columns, 2, 4, slot);
        return columns ? { type: 'columns', columns } : null;
      }
      if (value.type === 'grid') {
        if (!exactKeys(value, ['type', 'regions'])) return null;
        const span = (entry: unknown): entry is number => Number.isInteger(entry) && (entry as number) >= 1 && (entry as number) <= 12;
        const regions = parseList(value.regions, 1, 12, record((region): PageGridRegion | null => {
          if (!exactKeys(region, ['id', 'span', 'tabletSpan', 'title', 'blocks']) || !validId(region.id) || !span(region.span)
            || !optional(region.tabletSpan, span) || !optional(region.title, (title) => validText(title, MAX_TITLE))) return null;
          const blocks = slot(region.blocks);
          return blocks ? { id: region.id, span: region.span, ...present<PageGridRegion>(region, ['tabletSpan', 'title']), blocks } : null;
        }));
        return regions && new Set(regions.map((region) => region.id)).size === regions.length ? { type: 'grid', regions } : null;
      }
      if (!exactKeys(value, ['type', 'tabs'])) return null;
      const tabs = parseList(value.tabs, 2, 6, record((tab) => {
        if (!exactKeys(tab, ['label', 'blocks']) || !validText(tab.label, MAX_TITLE)) return null;
        const blocks = slot(tab.blocks);
        return blocks ? { label: tab.label, blocks } : null;
      }));
      return tabs ? { type: 'tabs', tabs } : null;
    }
    default:
      return parseRichBlock(value);
  }
}

/** Validates the complete stored block shape, including closed server metadata. */
export function parsePageBlock(value: unknown): PageBlock | null {
  if (!isRecord(value) || !validId(value.id) || !Number.isSafeInteger(value.rev) || (value.rev as number) < 1) return null;
  // The content parser admits only its own type's fields, so whatever else is left must be block metadata.
  const content = parsePageBlockInput(Object.fromEntries(Object.entries(value).filter(([key]) => !['id', 'rev', 'sources', 'edit'].includes(key))));
  if (!content) return null;
  let sources: BlockSource[] | undefined;
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || value.sources.length > MAX_SOURCES) return null;
    sources = [];
    for (const source of value.sources) { const parsed = parseBlockSource(source); if (!parsed) return null; sources.push(parsed); }
  }
  let edit: BlockEdit | undefined;
  if (value.edit !== undefined) {
    if (!isRecord(value.edit) || !exactKeys(value.edit, ['at']) || !Number.isSafeInteger(value.edit.at) || (value.edit.at as number) < 0) return null;
    edit = { at: value.edit.at as number };
  }
  return { ...content, id: value.id, rev: value.rev as number, ...(sources === undefined ? {} : { sources }), ...(edit === undefined ? {} : { edit }) } as PageBlock;
}

export function isPageBlockInput(value: unknown): value is PageBlockInput { return parsePageBlockInput(value) !== null; }
export function isPageBlock(value: unknown): value is PageBlock { return parsePageBlock(value) !== null; }
