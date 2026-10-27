import type {
  PageBlock,
  PageBlockInput,
  PageChangeDto,
  PageDatabase,
  PageDatabaseView,
  PageDto,
  PageSummaryDto,
  PageWriteResult,
  SpaceSummaryDto,
} from 'michi-shared';
import { backendEntityId, serverEntityId } from '../../config/backendIdentity';

export type IdentityDirection = 'renderer' | 'server';

function mapId(id: string, connectionId: string, direction: IdentityDirection): string {
  return direction === 'renderer' ? backendEntityId(connectionId, id) : serverEntityId(id, connectionId);
}

function mapNullableId(id: string | null, connectionId: string, direction: IdentityDirection): string | null {
  return id === null ? null : mapId(id, connectionId, direction);
}

function mapPageBlockReferences<T extends PageBlock | PageBlockInput>(block: T, connectionId: string, direction: IdentityDirection): T {
  if (block.type === 'markdown' && block.segmentSources) {
    return { ...block, segmentSources: block.segmentSources.map((segment) => ({ ...segment,
      sources: segment.sources.map((source) => ({ ...source, nodeId: mapId(source.nodeId, connectionId, direction) })),
    })) } as T;
  }
  if (block.type === 'toggle') {
    return { ...block, blocks: block.blocks.map((child) => mapPageBlockReferences(child, connectionId, direction)) } as T;
  }
  if (block.type === 'columns') {
    return { ...block, columns: block.columns.map((column) => column.map((child) => mapPageBlockReferences(child, connectionId, direction))) } as T;
  }
  if (block.type === 'tabs') {
    return { ...block, tabs: block.tabs.map((tab) => ({ ...tab, blocks: tab.blocks.map((child) => mapPageBlockReferences(child, connectionId, direction)) })) } as T;
  }
  if (block.type === 'grid') {
    return { ...block, regions: block.regions.map((region) => ({ ...region, blocks: region.blocks.map((child) => mapPageBlockReferences(child, connectionId, direction)) })) } as T;
  }
  const mapped = block.type === 'database-ref'
    ? { ...block, databaseId: mapId(block.databaseId, connectionId, direction) }
    : block.type === 'page-link'
      ? { ...block, pageId: mapId(block.pageId, connectionId, direction) }
      : block.type === 'component'
        ? { ...block, componentId: mapId(block.componentId, connectionId, direction) }
      : block.type === 'threads'
        ? { ...block, nodeIds: block.nodeIds.map((id) => mapId(id, connectionId, direction)) }
      : block.type === 'conflict'
        ? { ...block, options: block.options.map((option) => (option.nodeId ? { ...option, nodeId: mapId(option.nodeId, connectionId, direction) } : option)) }
      : block;
  return mapped as T;
}

export function mapPageBlockInputIdentity(block: PageBlockInput, connectionId: string, direction: IdentityDirection): PageBlockInput {
  return mapPageBlockReferences(block, connectionId, direction);
}

export function mapPageBlockIdentity(block: PageBlock, connectionId: string, direction: IdentityDirection): PageBlock {
  const mapped = mapPageBlockReferences(block, connectionId, direction);
  return block.sources
    ? { ...mapped, sources: block.sources.map((source) => ({ ...source, nodeId: mapId(source.nodeId, connectionId, direction) })) }
    : mapped;
}

export function mapPageSummaryIdentity<T extends PageSummaryDto>(
  page: T,
  connectionId: string,
  direction: IdentityDirection,
): T {
  return {
    ...page,
    id: mapId(page.id, connectionId, direction),
    workspaceId: mapId(page.workspaceId, connectionId, direction),
    parentId: mapNullableId(page.parentId, connectionId, direction),
    helperNodeId: mapNullableId(page.helperNodeId, connectionId, direction),
  };
}

export function mapSpaceSummaryIdentity(
  space: SpaceSummaryDto,
  connectionId: string,
  direction: IdentityDirection,
): SpaceSummaryDto {
  const page = mapPageSummaryIdentity(space, connectionId, direction);
  return {
    ...page,
    contributorNodeIds: space.contributorNodeIds.map((id) => mapId(id, connectionId, direction)),
  };
}

export function mapPageIdentity(page: PageDto, connectionId: string, direction: IdentityDirection): PageDto {
  const summary = mapPageSummaryIdentity(page, connectionId, direction);
  return { ...summary, blocks: page.blocks.map((block) => mapPageBlockIdentity(block, connectionId, direction)) };
}

export function mapPageDatabaseViewIdentity(
  view: PageDatabaseView,
  connectionId: string,
  direction: IdentityDirection,
): PageDatabaseView {
  return view.config.componentId
    ? { ...view, config: { ...view.config, componentId: mapId(view.config.componentId, connectionId, direction) } }
    : view;
}

export function mapDatabaseIdentity(
  database: PageDatabase,
  connectionId: string,
  direction: IdentityDirection,
): PageDatabase {
  return {
    ...database,
    id: mapId(database.id, connectionId, direction),
    workspaceId: mapId(database.workspaceId, connectionId, direction),
    views: database.views.map((view) => mapPageDatabaseViewIdentity(view, connectionId, direction)),
  };
}

function mapDatabaseSnapshot(value: unknown, connectionId: string, direction: IdentityDirection): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const database = value as Record<string, unknown>;
  const views = Array.isArray(database.views) ? database.views.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const view = value as Record<string, unknown>;
    if (!view.config || typeof view.config !== 'object' || Array.isArray(view.config)) return view;
    const config = view.config as Record<string, unknown>;
    return typeof config.componentId === 'string'
      ? { ...view, config: { ...config, componentId: mapId(config.componentId, connectionId, direction) } }
      : view;
  }) : undefined;
  return {
    ...database,
    ...(typeof database.id === 'string' ? { id: mapId(database.id, connectionId, direction) } : {}),
    ...(typeof database.workspaceId === 'string' ? { workspaceId: mapId(database.workspaceId, connectionId, direction) } : {}),
    ...(views ? { views } : {}),
  };
}

function mapSnapshot(value: unknown, connectionId: string, direction: IdentityDirection): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.kind === 'block' && snapshot.exists === true && snapshot.block && typeof snapshot.block === 'object') {
    return { ...snapshot, block: mapPageBlockIdentity(snapshot.block as PageBlock, connectionId, direction) };
  }
  if (snapshot.kind === 'database' && snapshot.exists === true) {
    return { ...snapshot, database: mapDatabaseSnapshot(snapshot.database, connectionId, direction) };
  }
  if (snapshot.kind === 'database' && snapshot.exists === false && typeof snapshot.id === 'string') {
    return { ...snapshot, id: mapId(snapshot.id, connectionId, direction) };
  }
  return snapshot;
}

function mapMutation(value: unknown, connectionId: string, direction: IdentityDirection): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const mutation = value as Record<string, unknown>;
  if (mutation.kind === 'block' && mutation.op === 'upsert' && mutation.block && typeof mutation.block === 'object') {
    return { ...mutation, block: mapPageBlockIdentity(mutation.block as PageBlock, connectionId, direction) };
  }
  if (mutation.kind === 'database' && mutation.op === 'replace') {
    return { ...mutation, database: mapDatabaseSnapshot(mutation.database, connectionId, direction) };
  }
  if (mutation.kind === 'database' && mutation.op === 'delete' && typeof mutation.id === 'string') {
    return { ...mutation, id: mapId(mutation.id, connectionId, direction) };
  }
  return mutation;
}

export function mapPageChangeIdentity(
  change: PageChangeDto,
  connectionId: string,
  direction: IdentityDirection,
): PageChangeDto {
  const target = change.target.kind === 'block'
    ? { ...change.target, pageId: mapId(change.target.pageId, connectionId, direction) }
    : change.target.kind === 'row'
      ? { ...change.target, databaseId: mapId(change.target.databaseId, connectionId, direction) }
      : { ...change.target, databaseId: mapId(change.target.databaseId, connectionId, direction) };
  let source = change.source;
  if (source.kind === 'chat' || source.kind === 'helper' || source.kind === 'maintenance') {
    source = {
      ...source,
      nodeId: mapId(source.nodeId, connectionId, direction),
      ...(source.kind === 'maintenance' ? {
        evidence: source.evidence.map((item) => ({ ...item, nodeId: mapId(item.nodeId, connectionId, direction) })),
      } : {}),
    };
  } else if (source.kind === 'component') {
    source = {
      ...source,
      componentId: mapId(source.componentId, connectionId, direction),
      ...('pageId' in source ? { pageId: mapId(source.pageId, connectionId, direction) } : {}),
      ...('databaseId' in source ? { databaseId: mapId(source.databaseId, connectionId, direction) } : {}),
    };
  }
  return {
    ...change,
    target,
    before: mapSnapshot(change.before, connectionId, direction) as PageChangeDto['before'],
    after: mapSnapshot(change.after, connectionId, direction) as PageChangeDto['after'],
    forward: mapMutation(change.forward, connectionId, direction) as PageChangeDto['forward'],
    inverse: mapMutation(change.inverse, connectionId, direction) as PageChangeDto['inverse'],
    source,
  };
}

export function mapPageWriteIdentity(
  write: PageWriteResult,
  connectionId: string,
  direction: IdentityDirection,
): PageWriteResult {
  return {
    ...write,
    resource: { ...write.resource, id: mapId(write.resource.id, connectionId, direction) },
    applied: write.applied.map((change) => mapPageChangeIdentity(change, connectionId, direction)),
    proposed: write.proposed.map((change) => mapPageChangeIdentity(change, connectionId, direction)),
  };
}

export function mapHelperDescriptorIdentity<T extends { workspaceId: string; treeId: string; nodeId: string }>(
  descriptor: T,
  connectionId: string,
  direction: IdentityDirection,
): T {
  return {
    ...descriptor,
    workspaceId: mapId(descriptor.workspaceId, connectionId, direction),
    treeId: mapId(descriptor.treeId, connectionId, direction),
    nodeId: mapId(descriptor.nodeId, connectionId, direction),
  };
}
