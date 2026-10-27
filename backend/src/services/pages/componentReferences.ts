import type { PageBlock, PageDatabase, ChangeSource } from 'michi-shared';
import { PageWriteError } from './core';
import { pageComponents, type ComponentHostReference } from './components';

const actorFor = (source: ChangeSource): 'user' | 'agent' => source.kind === 'user' ? 'user' : 'agent';

function validateComponentProps(workspaceId: string, ownerUserId: string, componentId: string, pinnedVersion: number | undefined, props: unknown): number {
  const version = pageComponents.read(workspaceId, ownerUserId, componentId, pinnedVersion).version;
  if (pageComponents.validateProps(workspaceId, ownerUserId, componentId, version, props) === null) {
    throw new PageWriteError(400, 'invalid', 'Invalid component props');
  }
  return version;
}

/** Validate library scope/schema, then atomically replace page block reference rows. */
export function savePageComponentReferences(args: {
  pageId: string; workspaceId: string; ownerUserId: string; revision: number; now: number;
  source: ChangeSource; blocks: readonly PageBlock[];
}): void {
  const actor = actorFor(args.source);
  const refs: ComponentHostReference[] = [];
  for (const block of args.blocks) {
    if (block.type !== 'component') continue;
    if (actor === 'user' && block.edit !== undefined && block.pinnedVersion === undefined) {
      throw new PageWriteError(400, 'invalid', 'User component references must pin a version');
    }
    const version = validateComponentProps(args.workspaceId, args.ownerUserId, block.componentId, block.pinnedVersion, block.props);
    refs.push({ componentId: block.componentId, workspaceId: args.workspaceId, kind: 'page_block', pageId: args.pageId, blockId: block.id,
      pinnedVersion: block.pinnedVersion ?? null, protected: actor === 'user' && block.edit !== undefined, hostRevision: args.revision });
    // Ensure a configured pin resolves to the exact immutable library revision.
    if (block.pinnedVersion !== undefined && block.pinnedVersion !== version) throw new PageWriteError(400, 'invalid', 'Invalid component version');
  }
  pageComponents.replaceReferences(args.ownerUserId, args.workspaceId, 'page_block', args.pageId, refs, args.now, actor);
}

/** Validate custom database views and index their immutable library references. */
export function saveDatabaseComponentReferences(args: {
  database: PageDatabase; ownerUserId: string; now: number; actor: 'user' | 'agent';
}): void {
  const refs: ComponentHostReference[] = [];
  for (const view of args.database.views) {
    if (view.type !== 'custom') continue;
    const humanEdited = 'edit' in view && view.edit !== undefined;
    const { componentId, pinnedVersion, props } = view.config;
    if (!componentId || !props) throw new PageWriteError(400, 'invalid', 'Invalid custom view component configuration');
    if (args.actor === 'user' && humanEdited && pinnedVersion === undefined) throw new PageWriteError(400, 'invalid', 'User component references must pin a version');
    const version = validateComponentProps(args.database.workspaceId, args.ownerUserId, componentId, pinnedVersion, props);
    refs.push({ componentId, workspaceId: args.database.workspaceId, kind: 'database_view', databaseId: args.database.id, viewId: view.id,
      pinnedVersion: pinnedVersion ?? null, protected: args.actor === 'user' && humanEdited, hostRevision: args.database.revision });
    if (pinnedVersion !== undefined && pinnedVersion !== version) throw new PageWriteError(400, 'invalid', 'Invalid component version');
  }
  pageComponents.replaceReferences(args.ownerUserId, args.database.workspaceId, 'database_view', args.database.id, refs, args.now, args.actor);
}

/** Pin newly human-edited component blocks before the write's history snapshot is built. */
export function pinHumanPageComponentBlocks(blocks: readonly PageBlock[], workspaceId: string, ownerUserId: string): PageBlock[] {
  return blocks.map((block) => {
    if (block.type !== 'component' || block.edit === undefined || block.pinnedVersion !== undefined) return block;
    const version = pageComponents.read(workspaceId, ownerUserId, block.componentId).version;
    return { ...block, pinnedVersion: version };
  });
}

/** Pin only views that carry the explicit user-edit marker, leaving unrelated views untouched. */
export function pinHumanDatabaseViews(database: PageDatabase, ownerUserId: string): PageDatabase {
  const views = database.views.map((view) => {
    if (view.type !== 'custom' || !('edit' in view) || view.edit === undefined || view.config.pinnedVersion !== undefined) return view;
    const version = pageComponents.read(database.workspaceId, ownerUserId, view.config.componentId!).version;
    return { ...view, config: { ...view.config, pinnedVersion: version } };
  });
  return views.every((view, index) => view === database.views[index]) ? database : { ...database, views };
}
