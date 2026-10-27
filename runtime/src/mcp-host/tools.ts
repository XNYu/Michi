import { McpHostRegistry, TOOL_NAME_PATTERN, redactId, slotSnapshot, type SlotRecord } from './registry';
import type {
  AskUserOption,
  AskUserQuestion,
  HostToolDef,
  HostToolSource,
  JsonSchemaObject,
  McpHostLog,
  SlotView,
  StructuredResultTool,
  ToolAnnotations,
  ToolCallContext,
  ToolResult,
  ToolSourceErrorMode,
} from './types';

/** One tool as a slot exposes it: a host tool or a builtin, already filtered for that slot. */
export interface CatalogEntry<B> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly annotations?: ToolAnnotations;
  run(args: Record<string, unknown>, ctx: ToolCallContext<B>): Promise<ToolResult>;
}

export const ASK_USER_TOOL = 'ask_user';
export const TOOL_CATALOG_UNAVAILABLE = 'tool catalog unavailable';

/** A tool source failed under sourceErrors 'fail': the slot has no catalog it can trust. */
export class ToolCatalogUnavailableError extends Error {
  constructor() {
    super(TOOL_CATALOG_UNAVAILABLE);
    this.name = 'ToolCatalogUnavailableError';
  }
}

/** What building a slot's catalog needs from the host. */
export interface CatalogContext<B> {
  registry: McpHostRegistry<B>;
  log: McpHostLog;
  sourceErrors: ToolSourceErrorMode;
}
export const DEFAULT_ANCHOR_DESCRIPTION = 'Session id of the calling agent session, as given in its session context.';
const SLOT_CLOSED = 'This MCP endpoint is closed; its session has ended.';

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function unknownToolResult(name: string): ToolResult {
  return errorResult(`Unknown tool: ${name}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isObjectSchema(schema: unknown): schema is JsonSchemaObject {
  return typeof schema === 'object' && schema !== null && (schema as { type?: unknown }).type === 'object';
}

/** Why a tool definition cannot be served, or undefined when it can. */
export function invalidToolDef(def: unknown): string | undefined {
  if (!isRecord(def)) return 'not an object';
  if (typeof def.name !== 'string' || !TOOL_NAME_PATTERN.test(def.name)) return 'invalid name';
  if (typeof def.handler !== 'function') return 'no handler';
  if (!isObjectSchema(def.inputSchema)) return 'inputSchema is not an object schema';
  return undefined;
}

// ---------------------------------------------------------------------------
// Builtins

const ASK_USER_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      description: 'Questions to ask (1-4).',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user.' },
          header: { type: 'string', description: 'Short label (max 12 chars) displayed as a chip/tag.' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            description: 'Available choices (2-4 options).',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Display text for this option (1-5 words).' },
                description: { type: 'string', description: 'Explanation of what this option means.' },
              },
              required: ['label'],
            },
          },
          multiSelect: { type: 'boolean', default: false, description: 'Allow multiple selections.' },
        },
        required: ['question', 'options'],
      },
    },
  },
  required: ['questions'],
};

/** Normalized questions, or an error message for the agent. */
function parseQuestions(raw: unknown): AskUserQuestion[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return 'questions must be an array of 1-4 questions.';
  const questions: AskUserQuestion[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry) || typeof entry.question !== 'string' || entry.question.trim() === '') {
      return `questions[${i}].question must be a non-empty string.`;
    }
    if (!Array.isArray(entry.options) || entry.options.length < 2 || entry.options.length > 4) {
      return `questions[${i}].options must list 2-4 options.`;
    }
    const options: AskUserOption[] = [];
    for (const [j, option] of entry.options.entries()) {
      if (!isRecord(option) || typeof option.label !== 'string' || option.label.trim() === '') {
        return `questions[${i}].options[${j}].label must be a non-empty string.`;
      }
      options.push(typeof option.description === 'string'
        ? { label: option.label, description: option.description }
        : { label: option.label });
    }
    const question: AskUserQuestion = { question: entry.question, options, multiSelect: entry.multiSelect === true };
    if (typeof entry.header === 'string') question.header = entry.header;
    questions.push(question);
  }
  return questions;
}

function askUserEntry<B>(): CatalogEntry<B> {
  return {
    name: ASK_USER_TOOL,
    description:
      'Ask the user one or more structured questions with selectable options. '
      + 'Use when you need the user to make a choice or provide input before proceeding. '
      + 'Each question can be single-select or multi-select, and users can always type a custom answer.',
    inputSchema: ASK_USER_SCHEMA,
    async run(args, ctx) {
      if (!ctx.sink.askUser) return errorResult('ask_user is not available for this session.');
      const questions = parseQuestions(args.questions);
      if (typeof questions === 'string') return errorResult(questions);
      const answers = await ctx.sink.askUser(questions, ctx.signal);
      if (!answers) return textResult('The user did not answer the questions (skipped or timed out).');
      return textResult(JSON.stringify({ answers }));
    },
  };
}

function structuredResultEntry<B>(def: StructuredResultTool): CatalogEntry<B> {
  return {
    name: def.name,
    description: def.description ?? 'Submit the final structured result of this task. Call it once, when the work is complete.',
    inputSchema: def.inputSchema,
    async run(args) {
      const verdict = def.submit(args);
      if (verdict?.ok === true) return textResult('Result submitted.');
      return errorResult(typeof verdict?.error === 'string' && verdict.error ? verdict.error : 'The result was rejected.');
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog and calls

function isVisible<B>(visible: (slot: SlotView<B>) => boolean, view: SlotView<B>, log: McpHostLog,
  name: string): boolean {
  try {
    return visible(view) === true;
  } catch (error) {
    log('warn', 'mcp host tool visible() threw; hiding the tool', { slot: redactId(view.slotId), tool: name, error: messageOf(error) });
    return false;
  }
}

function sourceDefs<B>(ctx: CatalogContext<B>, source: HostToolSource<B>, view: SlotView<B>, index: number): readonly HostToolDef<B>[] {
  const { log } = ctx;
  const logData = { slot: redactId(view.slotId), source: index };
  const failed = (problem: string, error?: unknown): readonly HostToolDef<B>[] => {
    const data = { ...logData, ...(error !== undefined ? { error: messageOf(error) } : {}) };
    if (ctx.sourceErrors === 'fail') {
      log('warn', `mcp host tool source ${problem}; the tool catalog is unavailable`, data);
      throw new ToolCatalogUnavailableError();
    }
    log('warn', `mcp host tool source ${problem}; it contributes no tools`, data);
    return [];
  };
  let defs: unknown;
  try {
    defs = source(view);
  } catch (error) {
    return failed('threw', error);
  }
  if (!Array.isArray(defs)) return failed('did not return an array');
  return defs.filter((def: unknown): def is HostToolDef<B> => {
    const problem = invalidToolDef(def);
    if (problem) log('warn', 'mcp host skipped an invalid tool from a source', { ...logData, problem });
    return !problem;
  });
}

/**
 * The tools a slot exposes right now, in order: builtins, then the entries of
 * every tool source (registration order, each in the order it returned), then
 * registerTool tools in registration order. On a name shared by two entries
 * the earlier wins: builtins > sources > registered tools. `allowTools` and
 * visible() filter all of them. Throws ToolCatalogUnavailableError when a
 * source fails under sourceErrors 'fail'.
 */
export function slotCatalog<B>(ctx: CatalogContext<B>, record: SlotRecord<B>): CatalogEntry<B>[] {
  const { registry, log } = ctx;
  const allowed = (name: string) => !record.allowTools || record.allowTools.has(name);
  const entries: CatalogEntry<B>[] = [];
  /** Name -> where the entry serving it came from. */
  const taken = new Map<string, string>();
  const add = (entry: CatalogEntry<B>, origin: string) => {
    if (!allowed(entry.name)) return;
    const owner = taken.get(entry.name);
    if (owner !== undefined) {
      log('warn', 'mcp host tool shadowed by an earlier entry with the same name', {
        slot: redactId(record.slotId), tool: entry.name, shadowed: origin, by: owner,
      });
      return;
    }
    taken.set(entry.name, origin);
    entries.push(entry);
  };
  if (record.builtins.askUser === true && record.sink.askUser) add(askUserEntry<B>(), 'builtin');
  if (record.builtins.structuredResult) add(structuredResultEntry<B>(record.builtins.structuredResult), 'builtin');
  const view = slotSnapshot(record);
  const addDef = (def: HostToolDef<B>, origin: string) => {
    if (!allowed(def.name)) return;
    if (def.visible && !isVisible(def.visible.bind(def), view, log, def.name)) return;
    add({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      ...(def.annotations ? { annotations: def.annotations } : {}),
      run: (args, ctx) => def.handler(args, ctx),
    }, origin);
  };
  // Snapshots: a source or handler that (un)registers while the catalog is built must not make it skip entries.
  const sources = [...registry.sources];
  const tools = [...registry.tools.values()];
  sources.forEach((source, index) => {
    for (const def of sourceDefs(ctx, source, view, index)) addDef(def, `tool source ${index}`);
  });
  for (const def of tools) addDef(def, 'registerTool');
  return entries;
}

function isToolResult(value: unknown): value is ToolResult {
  return isRecord(value) && Array.isArray(value.content);
}

/**
 * Runs one entry for a slot. The handler's signal aborts with the request,
 * on slot dispose and on host close; thrown errors become `isError` results.
 */
export async function runEntry<B>(entry: CatalogEntry<B>, record: SlotRecord<B>, args: Record<string, unknown>,
  call: { toolCallId?: string; signal: AbortSignal }, log: McpHostLog, logData: Record<string, unknown>): Promise<ToolResult> {
  if (record.disposed) return errorResult(SLOT_CLOSED);
  const controller = new AbortController();
  const forward = () => controller.abort(call.signal.reason);
  if (call.signal.aborted) forward();
  else call.signal.addEventListener('abort', forward, { once: true });
  record.inflight.add(controller);
  try {
    const result = await entry.run(args, {
      slot: slotSnapshot(record),
      sink: record.sink,
      signal: controller.signal,
      ...(call.toolCallId !== undefined ? { toolCallId: call.toolCallId } : {}),
    });
    if (isToolResult(result)) return result;
    log('warn', 'mcp host tool returned an invalid result', { ...logData, tool: entry.name });
    return errorResult(`Tool ${entry.name} returned an invalid result.`);
  } catch (error) {
    const message = messageOf(error);
    log('warn', 'mcp host tool call failed', { ...logData, tool: entry.name, error: message });
    return errorResult(message || `Tool ${entry.name} failed.`);
  } finally {
    record.inflight.delete(controller);
    call.signal.removeEventListener('abort', forward);
  }
}

// ---------------------------------------------------------------------------
// Session-group anchor

/** A tool that already declares the anchor property cannot be routed through a group. */
export function declaresAnchor<B>(entry: CatalogEntry<B>, anchorArg: string): boolean {
  const properties = entry.inputSchema.properties;
  return isRecord(properties) && Object.prototype.hasOwnProperty.call(properties, anchorArg);
}

export function withAnchor(schema: JsonSchemaObject, anchorArg: string,
  description: string = DEFAULT_ANCHOR_DESCRIPTION): JsonSchemaObject {
  return {
    ...schema,
    properties: {
      ...(isRecord(schema.properties) ? schema.properties : {}),
      [anchorArg]: { type: 'string', minLength: 1, description },
    },
    required: [...(Array.isArray(schema.required) ? schema.required.filter((name) => name !== anchorArg) : []), anchorArg],
  };
}
