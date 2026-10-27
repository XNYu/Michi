/** Native content contracts for the rich page renderers. Writes reject invalid
 * fields instead of clipping or dropping them as a display adapter may do. */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const text = z.string().max(2_000);
const title = z.string().max(200);
const namedTitle = title.refine((v) => v.trim().length > 0, 'Must contain text');
const filled = text.refine((v) => v.trim().length > 0, 'Must contain text');
const num = z.number().finite().min(-1e15).max(1e15);
const unit = z.number().finite().min(0).max(1);
const tone = z.enum(['info', 'warn', 'success', 'danger']);
const url = z.string().max(2_000).refine((v) => {
  if (v.trim() !== v) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password; } catch { return false; }
}, 'Expected an HTTPS address');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
});
const instant = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/)
  .refine((v) => day.safeParse(v.slice(0, 10)).success && Number.isFinite(Date.parse(v)));
const obj = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
const list = <S extends z.ZodTypeAny>(item: S, max = 50, min = 1) => z.array(item).min(min).max(max);
const block = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => obj({ type: z.literal(type), ...shape });
const long = z.string().max(20_000);
const picture = obj({ url, alt: text.optional(), caption: text.optional() });
const point = obj({ x: z.union([text, num]), y: num });
const series = list(obj({ label: text, points: list(point, 100) }), 10);
const xy = ['bar', 'line', 'area'] as const;
const chartHead = { type: z.literal('chart'), title: namedTitle };

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
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Chart data does not match its axes or nodes' });
  if (b.kind === 'radar' && b.series.some((s) => s.values.length !== b.axes.length)) fail();
  if (b.kind === 'pie' && !b.slices.some((s) => s.value > 0)) fail();
  if (b.kind === 'sankey') {
    const names = new Set(b.nodes.map((n) => n.name));
    if (names.size !== b.nodes.length) fail();
    const edges = new Map<string, string[]>();
    for (const link of b.links) {
      if (!names.has(link.source) || !names.has(link.target)) { fail(); continue; }
      const queue = [link.target], seen = new Set<string>();
      while (queue.length) {
        const name = queue.pop()!;
        if (name === link.source) { fail(); break; }
        if (seen.has(name)) continue;
        seen.add(name); queue.push(...edges.get(name) ?? []);
      }
      edges.set(link.source, [...edges.get(link.source) ?? [], link.target]);
    }
  }
});
export type RichChart = z.infer<typeof richChartSchema>;

const field = obj({ key: z.string().min(1).max(100).refine((v) => v.trim() === v && v.length > 0), label: filled, type: z.enum(['text', 'number', 'select', 'date', 'checkbox']),
  required: z.boolean().optional(), options: list(filled).optional() });

export const RICH_BLOCK_SCHEMAS = {
  quote: block('quote', { text, cite: text.optional() }),
  divider: block('divider', {}),
  toc: block('toc', {}),
  code: block('code', { code: long, title: title.optional(), lang: z.string().max(40).optional() }),
  diff: block('diff', { before: long, after: long, title: title.optional(), lang: z.string().max(40).optional() }).refine((b) => !!(b.before.trim() || b.after.trim())),
  math: block('math', { tex: filled, display: z.boolean().optional() }),
  mermaid: block('mermaid', { code: long.refine((v) => !!v.trim()) }),
  keyvalue: block('keyvalue', { title: title.optional(), items: list(obj({ key: filled, value: text })) }),
  tags: block('tags', { items: list(obj({ label: filled, tone: tone.optional() })) }),
  status: block('status', { label: namedTitle, tone: tone.optional(), summary: text.optional(), note: title.optional() }),
  stat: block('stat', { label: filled, value: text, delta: text.optional(), deltaTone: z.enum(['up', 'down', 'flat']).optional(), spark: list(num, 100, 2).optional() }),
  progress: block('progress', { title: namedTitle, actual: unit, expected: unit.optional() }),
  ring: block('ring', { title: title.optional(), items: list(obj({ label: filled, value: unit }), 8) }),
  gauge: block('gauge', { title: namedTitle, value: num, min: num, max: num, unit: text.optional() }).refine((b) => b.max > b.min),
  leaderboard: block('leaderboard', { title: namedTitle, items: list(obj({ name: filled, value: num, note: text.optional() })) }),
  rating: block('rating', { title: title.optional(), items: list(obj({ label: filled, score: z.number().finite().min(0).max(5) })) }),
  'pros-cons': block('pros-cons', { title: title.optional(), pros: list(text, 50, 0), cons: list(text, 50, 0) }).refine((b) => b.pros.length + b.cons.length > 0),
  choice: block('choice', { question: filled, options: list(filled), selected: z.number().int().nonnegative().optional() }).refine((b) => b.selected === undefined || b.selected < b.options.length),
  milestones: block('milestones', { title: title.optional(), items: list(obj({ label: filled, date: text, done: z.boolean(), note: title.optional(), tone: tone.optional() })) }),
  stepper: block('stepper', { title: title.optional(), steps: list(obj({ label: filled, text: text.optional() })), current: z.number().int().min(0) }).refine((b) => b.current <= b.steps.length),
  agenda: block('agenda', { title: title.optional(), date: text.optional(), items: list(obj({ time: filled, title: filled, note: text.optional() })) }),
  calendar: block('calendar', { title: title.optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), events: list(obj({ date: day, title: filled }), 100, 0) }).refine((b) => b.events.every((e) => e.date.startsWith(`${b.month}-`))),
  gantt: block('gantt', { title: title.optional(), items: list(obj({ label: filled, start: instant, end: instant, group: text.optional(), done: unit.optional() }).refine((b) => Date.parse(b.end) >= Date.parse(b.start))) }),
  countdown: block('countdown', { title: namedTitle, to: instant }),
  clocks: block('clocks', { zones: list(obj({ label: filled, tz: filled }), 12) }),
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
  actions: block('actions', { buttons: list(obj({ label: filled, prompt: filled }), 6) }),
  form: block('form', { title: namedTitle, fields: list(field, 20), submitLabel: text.optional(), prompt: filled }).refine((b) => new Set(b.fields.map((f) => f.key)).size === b.fields.length && b.fields.every((f) => f.type !== 'select' || !!f.options?.length)),
  poll: block('poll', { question: filled, options: list(filled, 50, 2), multi: z.boolean().optional() }).refine((b) => new Set(b.options).size === b.options.length),
} as const;
export type RichBlockType = keyof typeof RICH_BLOCK_SCHEMAS;
export type RichBlockContent = z.infer<(typeof RICH_BLOCK_SCHEMAS)[RichBlockType]>;

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
