import type { PageBlock, PageBlockContent } from './blocks';
import type { PageDatabase, PageDatabaseColumn, PageDatabaseRow, PageDatabaseView } from './database';

export type PageTemplateKey = 'blank' | 'release' | 'research' | 'travel';
export type PageTemplateIdKind = 'block' | 'database' | 'column' | 'view' | 'row';
export type PageTemplateIdFactory = (kind: PageTemplateIdKind) => string;

export interface PageTemplateOptions {
  /** Required for templates that include a database. */
  workspaceId?: string;
  /** Creation timestamp shared by the initial database and its scaffold row. */
  now?: number;
  /** The backend should supply its transactional server ID allocator. */
  idFactory?: PageTemplateIdFactory;
}

export interface PageTemplateMaterialization {
  blocks: PageBlock[];
  databases: PageDatabase[];
}

interface RawColumn extends Omit<PageDatabaseColumn, 'id'> { placeholder: string }
interface RawView extends Omit<PageDatabaseView, 'id' | 'position'> { placeholder: string; position: number }
interface RawDatabase {
  placeholder: string;
  title: string;
  columns: RawColumn[];
  view: RawView;
  rowPlaceholder: string;
}
interface PageTemplateDefinition {
  blocks: PageBlockContent[];
  database?: RawDatabase;
}

const emptyViewConfig = () => ({ filters: [], match: 'all' as const, sorts: [] });

/**
 * Template IDs are symbolic `$0` placeholders. A creation transaction resolves
 * each placeholder through its own server allocator, so retries can persist the
 * exact assigned result with their write receipt.
 */
export const PAGE_TEMPLATES: Readonly<Record<PageTemplateKey, PageTemplateDefinition>> = {
  blank: {
    blocks: [{ type: 'markdown', text: '' }],
  },
  release: {
    blocks: [
      { type: 'heading', text: 'Goal' },
      { type: 'markdown', text: '' },
      { type: 'heading', text: 'Progress' },
      { type: 'callout', text: '', tone: 'info' },
      { type: 'heading', text: 'Risks' },
      { type: 'markdown', text: '' },
      { type: 'heading', text: 'Release checklist' },
      { type: 'database-ref', databaseId: '$0', viewId: '$0' },
    ],
    database: {
      placeholder: '$0',
      title: 'Release checklist',
      columns: [
        { placeholder: '$0', name: 'Task', type: 'text' },
        { placeholder: '$1', name: 'Status', type: 'select', options: [
          { value: 'todo', label: 'To do', color: 'gray' },
          { value: 'doing', label: 'In progress', color: 'blue' },
          { value: 'done', label: 'Done', color: 'green' },
        ] },
        { placeholder: '$2', name: 'Owner', type: 'text' },
      ],
      view: { placeholder: '$0', name: 'Board', type: 'board', position: 0, config: { ...emptyViewConfig(), group: '$1' } },
      rowPlaceholder: '$0',
    },
  },
  research: {
    blocks: [
      { type: 'heading', text: 'Question' },
      { type: 'markdown', text: '' },
      { type: 'heading', text: 'Findings' },
      { type: 'markdown', text: '' },
      { type: 'heading', text: 'Sources' },
      { type: 'markdown', text: '' },
    ],
  },
  travel: {
    blocks: [
      { type: 'heading', text: 'Plan' },
      { type: 'markdown', text: '' },
      { type: 'callout', title: 'Budget', text: '', tone: 'info' },
      { type: 'heading', text: 'Itinerary' },
      { type: 'database-ref', databaseId: '$0', viewId: '$0' },
    ],
    database: {
      placeholder: '$0',
      title: 'Itinerary',
      columns: [
        { placeholder: '$0', name: 'Day', type: 'number' },
        { placeholder: '$1', name: 'Date', type: 'date' },
        { placeholder: '$2', name: 'Place', type: 'text' },
        { placeholder: '$3', name: 'Stay', type: 'text' },
        { placeholder: '$4', name: 'Status', type: 'select', options: [
          { value: 'planned', label: 'Planned', color: 'gray' },
          { value: 'booked', label: 'Booked', color: 'blue' },
          { value: 'done', label: 'Done', color: 'green' },
        ] },
      ],
      view: { placeholder: '$0', name: 'Table', type: 'table', position: 0, config: emptyViewConfig() },
      rowPlaceholder: '$0',
    },
  },
};

let materializationCounter = 0;
function defaultIdFactory(kind: PageTemplateIdKind): string {
  materializationCounter += 1;
  const entropy = Math.random().toString(36).slice(2, 12);
  return `${kind}-${Date.now().toString(36)}-${materializationCounter.toString(36)}-${entropy}`;
}

function nextId(factory: PageTemplateIdFactory, kind: PageTemplateIdKind, used: Set<string>): string {
  const value = factory(kind);
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw new TypeError(`idFactory returned an invalid ${kind} id`);
  if (used.has(value)) throw new TypeError(`idFactory returned a duplicate id: ${value}`);
  used.add(value);
  return value;
}

function materializeDatabase(raw: RawDatabase, workspaceId: string, factory: PageTemplateIdFactory, used: Set<string>, now: number): { database: PageDatabase; databaseId: string; viewId: string } {
  const databaseId = nextId(factory, 'database', used);
  const columns = raw.columns.map(({ placeholder: _placeholder, ...column }) => ({ ...column, id: nextId(factory, 'column', used) } as PageDatabaseColumn));
  const viewId = nextId(factory, 'view', used);
  const view: PageDatabaseView = {
    id: viewId,
    name: raw.view.name,
    type: raw.view.type,
    position: raw.view.position,
    config: {
      ...raw.view.config,
      ...(raw.view.config.group === undefined ? {} : { group: columns.find((column) => column.name === 'Status')?.id }),
    },
  };
  const row: PageDatabaseRow = {
    id: nextId(factory, 'row', used),
    values: {},
    position: 0,
    updatedAt: now,
    rev: 1,
    edited: {},
    bodyEditedAt: null,
  };
  const database: PageDatabase = {
    id: databaseId,
    workspaceId,
    title: raw.title,
    columns,
    views: [view],
    rows: [row],
    revision: 1,
    updatedAt: now,
  };
  return { database, databaseId, viewId };
}

/** Materialize a fresh revision-1 page scaffold with no human ownership. */
export function materializePageTemplate(
  template: PageTemplateKey,
  idFactoryOrOptions?: PageTemplateIdFactory | PageTemplateOptions,
): PageTemplateMaterialization {
  const definition = PAGE_TEMPLATES[template];
  if (!definition) throw new TypeError(`Unknown page template: ${String(template)}`);
  const options: PageTemplateOptions = typeof idFactoryOrOptions === 'function'
    ? { idFactory: idFactoryOrOptions }
    : idFactoryOrOptions ?? {};
  const factory = options.idFactory ?? defaultIdFactory;
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('now must be a non-negative safe integer');
  const used = new Set<string>();
  let databaseId: string | undefined;
  let viewId: string | undefined;
  const databases: PageDatabase[] = [];
  if (definition.database) {
    if (!options.workspaceId) throw new TypeError(`workspaceId is required for the ${template} template`);
    const result = materializeDatabase(definition.database, options.workspaceId, factory, used, now);
    databaseId = result.databaseId;
    viewId = result.viewId;
    databases.push(result.database);
  }
  const blocks = definition.blocks.map((content): PageBlock => {
    const resolved: PageBlockContent = content.type === 'database-ref'
      ? { ...content, databaseId: databaseId ?? content.databaseId, ...(content.viewId ? { viewId: viewId ?? content.viewId } : {}) }
      : { ...content } as PageBlockContent;
    return { ...resolved, id: nextId(factory, 'block', used), rev: 1 } as PageBlock;
  });
  return { blocks, databases };
}
