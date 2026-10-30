/** Native content contracts for the rich page renderers. Writes reject invalid
 * fields instead of clipping or dropping them as a display adapter may do. */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const text = z.string().max(2_000);
const title = z.string().max(200);
const namedTitle = title.refine((v) => v.trim().length > 0, 'must contain text');
const filled = text.refine((v) => v.trim().length > 0, 'must contain text');
const num = z.number().finite().min(-1e15).max(1e15);
const unit = z.number().finite().min(0).max(1);
const tone = z.enum(['info', 'warn', 'success', 'danger']);
const url = z.string().max(2_000).refine((v) => {
  if (v.trim() !== v) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password; } catch { return false; }
}, 'must be an https address').describe('https URL');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date YYYY-MM-DD').refine((v) => {
  const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'must be a real date YYYY-MM-DD').describe('YYYY-MM-DD');
const instant = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/, 'must be an ISO 8601 date or date-time')
  .refine((v) => day.safeParse(v.slice(0, 10)).success && Number.isFinite(Date.parse(v)), 'must be a real ISO 8601 date or date-time')
  .describe('ISO 8601 date or date-time');
const obj = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
const list = <S extends z.ZodTypeAny>(item: S, max = 50, min = 1) => z.array(item).min(min).max(max);
const block = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => obj({ type: z.literal(type), ...shape });
const long = z.string().max(20_000);
const picture = obj({ url, alt: text.optional(), caption: text.optional() });
const point = obj({ x: z.union([text, num]), y: num });
const series = list(obj({ label: text, points: list(point, 100) }), 10);
const xy = ['bar', 'line', 'area'] as const;
const chartHead = { type: z.literal('chart'), title: namedTitle };

/** Rules the JSON Schema cannot say; each is also the message of the check that enforces it. */
export const RICH_CHART_RULES = {
  radar: 'every radar series needs one value per axis',
  pie: 'at least one pie slice must be above 0',
  sankeyNames: 'sankey node names must be unique',
  sankeyLinks: 'every sankey link source and target must be a node name',
  sankeyCycle: 'sankey links must not form a cycle',
} as const;

/** The new chart shapes coexist with the stored labels/values shape. */
export const richChartSchema = z.discriminatedUnion('kind', [
  obj({ ...chartHead, kind: z.enum(xy), series, stacked: z.boolean().optional() }),
  obj({ ...chartHead, kind: z.literal('composite'), series: list(obj({ label: text, as: z.enum(xy), points: list(point, 100) }), 10) }),
  obj({ ...chartHead, kind: z.literal('pie'), slices: list(obj({ label: filled, value: num.min(0) })), donut: z.boolean().optional() }),
  obj({ ...chartHead, kind: z.enum(['scatter', 'bubble']), series: list(obj({ label: text, points: list(obj({ x: num, y: num, z: num.optional() }), 100) }), 10) }),
  obj({ ...chartHead, kind: z.literal('radar'), axes: list(filled, 12, 3), series: list(obj({ label: text, values: list(num, 12, 3) }), 10) }),
  obj({ ...chartHead, kind: z.literal('heatmap'), days: list(obj({ date: day, value: num }), 400) }),
  obj({ ...chartHead, kind: z.literal('funnel'), steps: list(obj({ label: filled, value: num.min(0) })) }),
  obj({ ...chartHead, kind: z.literal('sparkline'), values: list(num, 100, 2) }),
  obj({ ...chartHead, kind: z.literal('sankey'), nodes: list(obj({ name: filled }), 50, 2), links: list(obj({ source: filled, target: filled, value: num.positive() }), 100) }),
]).superRefine((b, ctx) => {
  const failed = new Set<string>();
  const fail = (message: string) => { if (!failed.has(message)) { failed.add(message); ctx.addIssue({ code: 'custom', message }); } };
  if (b.kind === 'radar' && b.series.some((s) => s.values.length !== b.axes.length)) fail(RICH_CHART_RULES.radar);
  if (b.kind === 'pie' && !b.slices.some((s) => s.value > 0)) fail(RICH_CHART_RULES.pie);
  if (b.kind === 'sankey') {
    const names = new Set(b.nodes.map((n) => n.name));
    if (names.size !== b.nodes.length) fail(RICH_CHART_RULES.sankeyNames);
    const edges = new Map<string, string[]>();
    for (const link of b.links) {
      if (!names.has(link.source) || !names.has(link.target)) { fail(RICH_CHART_RULES.sankeyLinks); continue; }
      const queue = [link.target], seen = new Set<string>();
      while (queue.length) {
        const name = queue.pop()!;
        if (name === link.source) { fail(RICH_CHART_RULES.sankeyCycle); break; }
        if (seen.has(name)) continue;
        seen.add(name); queue.push(...edges.get(name) ?? []);
      }
      edges.set(link.source, [...edges.get(link.source) ?? [], link.target]);
    }
  }
});
export type RichChart = z.infer<typeof richChartSchema>;

const field = obj({ key: z.string().min(1).max(100).refine((v) => v.trim() === v && v.length > 0, 'must not start or end with spaces'), label: filled, type: z.enum(['text', 'number', 'select', 'date', 'checkbox']),
  required: z.boolean().optional(), options: list(filled).optional() });

/** Rules across fields that the JSON Schema cannot say; each is also the message of the check that enforces it. */
const RULES = {
  diff: 'before or after must contain text',
  'pros-cons': 'pros and cons together need at least one entry',
  choice: 'selected is an index into options',
  stepper: 'current is at most the number of steps',
  gauge: 'max is greater than min',
  calendar: 'every event date falls in month',
  gantt: 'each item ends on or after its start',
  formKeys: 'field keys are unique',
  formSelect: 'a select field needs options',
  poll: 'options are unique',
} as const;

export const RICH_BLOCK_SCHEMAS = {
  quote: block('quote', { text, cite: text.optional() }),
  divider: block('divider', {}),
  toc: block('toc', {}),
  code: block('code', { code: long, title: title.optional(), lang: z.string().max(40).optional() }),
  diff: block('diff', { before: long, after: long, title: title.optional(), lang: z.string().max(40).optional() }).refine((b) => !!(b.before.trim() || b.after.trim()), RULES.diff),
  math: block('math', { tex: filled, display: z.boolean().optional() }),
  mermaid: block('mermaid', { code: long.refine((v) => !!v.trim(), 'must contain text') }),
  keyvalue: block('keyvalue', { title: title.optional(), items: list(obj({ key: filled, value: text })) }),
  tags: block('tags', { items: list(obj({ label: filled, tone: tone.optional() })) }),
  status: block('status', { label: namedTitle, tone: tone.optional(), summary: text.optional(), note: title.optional() }),
  stat: block('stat', { label: filled, value: text, delta: text.optional(), deltaTone: z.enum(['up', 'down', 'flat']).optional(), spark: list(num, 100, 2).optional() }),
  progress: block('progress', { title: namedTitle, actual: unit, expected: unit.optional() }),
  ring: block('ring', { title: title.optional(), items: list(obj({ label: filled, value: unit }), 8) }),
  gauge: block('gauge', { title: namedTitle, value: num, min: num, max: num, unit: text.optional() }).refine((b) => b.max > b.min, RULES.gauge),
  leaderboard: block('leaderboard', { title: namedTitle, items: list(obj({ name: filled, value: num, note: text.optional() })) }),
  rating: block('rating', { title: title.optional(), items: list(obj({ label: filled, score: z.number().finite().min(0).max(5) })) }),
  'pros-cons': block('pros-cons', { title: title.optional(), pros: list(text, 50, 0), cons: list(text, 50, 0) }).refine((b) => b.pros.length + b.cons.length > 0, RULES['pros-cons']),
  choice: block('choice', { question: filled, options: list(filled), selected: z.number().int().nonnegative().optional() }).refine((b) => b.selected === undefined || b.selected < b.options.length, RULES.choice),
  milestones: block('milestones', { title: title.optional(), items: list(obj({ label: filled, date: text, done: z.boolean(), note: title.optional(), tone: tone.optional() })) }),
  stepper: block('stepper', { title: title.optional(), steps: list(obj({ label: filled, text: text.optional() })), current: z.number().int().min(0) }).refine((b) => b.current <= b.steps.length, RULES.stepper),
  agenda: block('agenda', { title: title.optional(), date: text.optional(), items: list(obj({ time: filled, title: filled, note: text.optional() })) }),
  calendar: block('calendar', { title: title.optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month YYYY-MM').describe('YYYY-MM'), events: list(obj({ date: day, title: filled }), 100, 0) }).refine((b) => b.events.every((e) => e.date.startsWith(`${b.month}-`)), RULES.calendar),
  gantt: block('gantt', { title: title.optional(), items: list(obj({ label: filled, start: instant, end: instant, group: text.optional(), done: unit.optional() }).refine((b) => Date.parse(b.end) >= Date.parse(b.start), RULES.gantt)) }),
  countdown: block('countdown', { title: namedTitle, to: instant }),
  clocks: block('clocks', { zones: list(obj({ label: filled, tz: filled.describe('IANA time zone such as Asia/Tokyo') }), 12) }),
  image: block('image', picture.shape),
  'before-after': block('before-after', { before: url, after: url, caption: text.optional() }),
  carousel: block('carousel', { items: list(obj({ url, caption: text.optional() })) }),
  video: block('video', { url, caption: text.optional() }),
  audio: block('audio', { url, caption: text.optional() }),
  embed: block('embed', { url, title: title.optional(), height: z.number().int().min(120).max(1200).optional() }),
  link: block('link', { url, title, description: text.optional(), image: url.optional(), site: text.optional() }),
  file: block('file', { path: filled, title: title.optional(), note: text.optional() }),
  person: block('person', { name: filled, role: text.optional(), avatar: url.optional(), note: text.optional(), links: list(obj({ label: filled, url }), 10, 0).optional() }),
  place: block('place', { name: filled, address: text.optional(), note: text.optional(), url: url.optional() }),
  actions: block('actions', { buttons: list(obj({ label: filled, prompt: filled.describe('text sent to the assistant when pressed') }), 6) }),
  form: block('form', { title: namedTitle, fields: list(field, 20), submitLabel: text.optional(), prompt: filled })
    .refine((b) => new Set(b.fields.map((f) => f.key)).size === b.fields.length, RULES.formKeys)
    .refine((b) => b.fields.every((f) => f.type !== 'select' || !!f.options?.length), RULES.formSelect),
  poll: block('poll', { question: filled, options: list(filled, 50, 2), multi: z.boolean().optional() }).refine((b) => new Set(b.options).size === b.options.length, RULES.poll),
} as const;
export type RichBlockType = keyof typeof RICH_BLOCK_SCHEMAS;
export type RichBlockContent = z.infer<(typeof RICH_BLOCK_SCHEMAS)[RichBlockType]>;

const RULE_TEXTS = new Set<string>([...Object.values(RULES), ...Object.values(RICH_CHART_RULES)]);

/** Each type's rules beyond its fields, for tool descriptions. */
export const RICH_BLOCK_RULES: Partial<Record<RichBlockType, string>> = {
  diff: RULES.diff, 'pros-cons': RULES['pros-cons'], choice: RULES.choice, stepper: RULES.stepper, gauge: RULES.gauge,
  calendar: RULES.calendar, gantt: RULES.gantt, form: `${RULES.formKeys}; ${RULES.formSelect}`, poll: RULES.poll,
};

export function parseRichBlock(value: unknown): RichBlockContent | null {
  if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string' || !Object.prototype.hasOwnProperty.call(RICH_BLOCK_SCHEMAS, value.type)) return null;
  const parsed = RICH_BLOCK_SCHEMAS[value.type as RichBlockType].safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function richBlockJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { $schema: _schema, ...json } = (zodToJsonSchema as unknown as (schema: z.ZodTypeAny, options: { $refStrategy: 'none' }) => Record<string, unknown>)(schema, { $refStrategy: 'none' });
  const properties = json.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties?.type && 'const' in properties.type) properties.type = { type: 'string', enum: [properties.type.const] };
  return json;
}

// ── Saying what is wrong ────────────────────────────────────────────────────

/** `items[0].label` from a base path and the segments below it; '' is the block itself. */
export function blockPath(base: string, segments: ReadonlyArray<string | number>): string {
  return segments.reduce<string>((path, segment) => typeof segment === 'number' ? `${path}[${segment}]` : path ? `${path}.${segment}` : segment, base);
}

/** `, not 5` for a short value the agent sent, so it sees what it wrote. */
export function sentValue(value: unknown): string {
  if (value === undefined || value === null || typeof value === 'object') return '';
  const shown = JSON.stringify(value);
  return shown.length > 60 ? '' : `, not ${shown}`;
}

const valueAt = (root: unknown, segments: ReadonlyArray<string | number>): unknown =>
  segments.reduce<unknown>((value, segment) => (value && typeof value === 'object' ? (value as Record<string | number, unknown>)[segment] : undefined), root);

const items = (count: number) => `${count} item${count === 1 ? '' : 's'}`;

function issueText(issue: z.ZodIssue, root: unknown, base: string): string {
  const path = blockPath(base, issue.path);
  const where = path || 'the block';
  const sent = sentValue(valueAt(root, issue.path));
  switch (issue.code) {
    case 'unrecognized_keys': return issue.keys.map((key) => `${blockPath(path, [key])} is not a field`).join('; ');
    case 'invalid_type': return issue.received === 'undefined' ? `${where} is required` : `${where} must be ${issue.expected}, not ${issue.received}`;
    case 'invalid_literal': return `${where} must be ${JSON.stringify(issue.expected)}${sent}`;
    case 'invalid_enum_value': return `${where} must be one of ${issue.options.join('|')}${sent}`;
    case 'invalid_union_discriminator': return `${where} must be one of ${issue.options.map(String).join('|')}${sent}`;
    case 'invalid_union': return `${where} does not match any of its allowed forms${sent}`;
    case 'too_small':
      if (issue.type === 'array') return `${where} needs at least ${items(Number(issue.minimum))}`;
      if (issue.type === 'string') return `${where} must be at least ${issue.minimum} characters`;
      return `${where} must be ${issue.inclusive ? 'at least' : 'greater than'} ${issue.minimum}${sent}`;
    case 'too_big':
      if (issue.type === 'array') return `${where} has more than ${items(Number(issue.maximum))}`;
      if (issue.type === 'string') return `${where} is longer than ${issue.maximum} characters`;
      return `${where} must be ${issue.inclusive ? 'at most' : 'less than'} ${issue.maximum}${sent}`;
    default:
      // A rule across fields names them itself; a single field's check is placed by its path.
      if (RULE_TEXTS.has(issue.message)) return `${where} breaks the rule "${issue.message}"`;
      return `${where}: ${issue.message}${sent}`;
  }
}

/** Every reason a value fails a zod content schema, each naming the field: `items[0].done is required`. */
export function zodBlockIssues(schema: z.ZodTypeAny, value: unknown, base = ''): string[] {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : [...new Set(parsed.error.issues.map((issue) => issueText(issue, value, base)))];
}

// ── Fields in brief ─────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const bound = (n: unknown): n is number => typeof n === 'number' && Math.abs(n) < 1e15;

/** A count range for a list: ` (1-50)`, ` (at most 8)`, ` (2-100)`. */
function countText(schema: Json): string {
  const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
  const max = schema.maxItems;
  if (typeof max !== 'number') return min ? ` (at least ${min})` : '';
  return min ? ` (${min}-${max})` : ` (at most ${max})`;
}

/**
 * A JSON Schema as a one-line type an agent can follow:
 * `{title?, items: [{label, value: number 0..1}] (1-8)}`. Plain text stays
 * unannotated; enums, numbers, booleans, formats and list sizes are spelled out.
 */
export function briefJsonSchema(schema: Json, skip: readonly string[] = ['type']): string {
  const branches = (schema.anyOf ?? schema.oneOf) as Json[] | undefined;
  if (Array.isArray(branches)) return branches.map((branch) => briefJsonSchema(branch, skip)).join(' | ');
  if ('const' in schema) return typeof schema.const === 'string' ? schema.const : JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(String).join('|');
  const described = typeof schema.description === 'string' && schema.type !== 'object' ? schema.description : '';
  switch (schema.type) {
    case 'object': {
      const properties = schema.properties as Record<string, Json> | undefined;
      if (!properties) return described || 'object';
      const required = new Set((schema.required as string[] | undefined) ?? []);
      return `{${Object.entries(properties).filter(([key]) => !skip.includes(key)).map(([key, value]) => {
        const brief = briefJsonSchema(value, []);
        return `${key}${required.has(key) ? '' : '?'}${brief === 'text' ? '' : `: ${brief}`}`;
      }).join(', ')}}`;
    }
    case 'array': return `[${briefJsonSchema((schema.items as Json | undefined) ?? {}, [])}]${countText(schema)}${schema.uniqueItems ? ' each once' : ''}`;
    case 'boolean': return 'boolean';
    case 'number':
    case 'integer': {
      const name = schema.type === 'integer' ? 'integer' : 'number';
      const low = bound(schema.minimum) ? schema.minimum : bound(schema.exclusiveMinimum) ? schema.exclusiveMinimum : undefined;
      const high = bound(schema.maximum) ? schema.maximum : undefined;
      const range = low !== undefined && high !== undefined ? ` ${low}..${high}`
        : low !== undefined ? ` ${bound(schema.exclusiveMinimum) ? '>' : '≥'} ${low}` : high !== undefined ? ` ≤ ${high}` : '';
      return `${name}${range}${described ? ` (${described})` : ''}`;
    }
    case 'string': return described || 'text';
    default: {
      // A union zod-to-json-schema flattened into a list of types, such as text or number.
      if (Array.isArray(schema.type)) return schema.type.map((type) => (type === 'string' ? 'text' : String(type))).join('|');
      return described || 'any';
    }
  }
}
