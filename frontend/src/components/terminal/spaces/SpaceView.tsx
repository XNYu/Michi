import React from 'react';
import type { BlockSource, MichiPageBlock, PageBlock, PageEditOp, SpaceSummaryDto } from 'michi-shared';
import { PAGE_COMPONENT_LIMITS, isComponentRecord, validatePageComponentProps } from 'michi-shared';
import type { JsonSchema, PageComponent } from 'michi-shared';
import { createWorkspaceDatabase, listWorkspaceDatabases, patchPage } from '../../../services/api/pages';
import { openTaskDatabase } from '../../../services/api/taskDatabase';
import { notifyPageChanged } from '../../../state/pages/pageEvents';
import type { MichiMenuEntry } from '../content/page/MichiMenu';
import { useChatActions, useChatProjects, useChatNodesSnapshot } from '../../../state/chatStore';
import { revealPageSource } from '../../../state/pages/revealSource';
import { useSpaceTree } from '../../../state/pages/useSpaceTree';
import { usePage } from '../../../state/pages/usePage';
import { dispatchPageHelperDraft } from '../../../state/pages/pageHelperDraft';
import { pageIsWithin, pageSpaceSubtree, usePageActions } from './usePageActions';
import NativePageDocument from './NativePageDocument';
import NativeDatabase from './NativeDatabase';
import { NativeTaskView } from './NativeTaskView';
import SpaceOutline from './SpaceOutline';
import './spaces.css';
import { DocumentShell } from '../content/page/DocumentShell';
import { MichiMenu } from '../content/page/MichiMenu';
import { MoreHorizontal, Sparkles, Settings2 } from 'lucide-react';
import { useSpaces } from '../../../state/pages/useSpaces';
import { homeAge } from './home/homeFormat';
// A Space page is laid out like the workspace homes: their column, header and block styles.
import './home/home.css';
import { publishSpaceTopbar } from '../../../state/pages/spaceTopbar';
import { PageChanges } from './PageChanges';
import { PageChangeTargets } from './PageChangeTargets';
import { blockItemTarget, useMetaChatTargeting } from './metaChat/SpacesMetaChat';
import { useMetaChatDocked } from './metaChat/MetaChatArea';
import { MaintenanceStatus } from './MaintenanceStatus';
import { readPageComponent } from '../../../services/api/pageComponents';
import { CustomBlock } from './components/CustomBlock';
import { SpaceSettings } from './SpaceSettings';
import { ComponentLibrary } from './components/ComponentLibrary';
import { LiveThreadCards } from './NativeThreadCards';
import { useHomeNavigation } from './home/useHomeNavigation';
import type { PageChangeDto } from 'michi-shared';
import type { OpenNativePageRoute } from './SpacesPage';
import { NewChatSheetSlot, PageProgressCards } from './conversation/SpaceConversationSlot';
import { openNewChatSheet } from '../../../state/spaceConversations/store';
import { useLayoutRulesMenu } from './layoutRules/LayoutRulesMenu';

export type SpaceRoute = { type: 'spaces' } | { type: 'space'; pageId: string; workspaceId: string; backendConnectionId: string };

function defaultComponentValue(schema: JsonSchema, depth = 0): unknown {
  if (depth > PAGE_COMPONENT_LIMITS.schemaDepth) return null;
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === 'string') {
    const min = schema.minLength ?? 0;
    const max = schema.maxLength ?? Math.max(min, 'Example'.length);
    return max < min ? null : 'Example'.slice(0, max).padEnd(min, 'x');
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const min = schema.minimum ?? 0;
    const value = schema.type === 'integer' ? Math.ceil(min) : min;
    return schema.maximum !== undefined && value > schema.maximum ? null : value;
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'null') return null;
  if (schema.type === 'array') {
    const count = schema.minItems ?? 0;
    if (count > 2_000 || (schema.maxItems !== undefined && count > schema.maxItems)) return null;
    return Array.from({ length: count }, () => schema.items ? defaultComponentValue(schema.items, depth + 1) : null);
  }
  const props: Record<string, unknown> = {};
  for (const name of schema.required ?? []) {
    const child = schema.properties?.[name];
    if (child) props[name] = defaultComponentValue(child, depth + 1);
  }
  return props;
}

function defaultComponentProps(schema: JsonSchema | null | undefined): Record<string, unknown> {
  const candidate = schema ? defaultComponentValue(schema) : {};
  const props = isComponentRecord(candidate) ? candidate : {};
  const validated = validatePageComponentProps(schema ?? null, props);
  if (!validated) throw new Error('This component needs custom property values before it can be inserted.');
  return validated;
}

/** `Space · rabbitholes · created by you`: the Space's workspace and who made it. */
export function spaceCaption(workspaceName: string, createdBy: SpaceSummaryDto['createdBy']): string {
  const by = createdBy === 'user' ? 'created by you' : createdBy === 'meta-agent' ? 'created by the Meta agent' : createdBy === 'agent' ? 'created by an agent' : null;
  return ['Page', workspaceName, by].filter(Boolean).join(' · ');
}

/** The line under a Space page's title: pages inside, how many conversations wrote here, when it last changed. */
export function spaceMetaLine({ pagesInside, parentTitle, conversations, updatedAt, state, now = Date.now() }: {
  pagesInside: number | null;
  parentTitle: string | null;
  conversations: number | null;
  updatedAt: number;
  state: string | null;
  now?: number;
}): string {
  const line = [
    pagesInside ? `${pagesInside} ${pagesInside === 1 ? 'page' : 'pages'} inside` : null,
    parentTitle ? `in ${parentTitle}` : null,
    conversations ? `${conversations} ${conversations === 1 ? 'conversation' : 'conversations'} wrote here` : null,
    `updated ${homeAge(updatedAt, now)}`,
    state,
  ].filter(Boolean).join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The conversations whose words are on these blocks. */
function blockSourceCount(blocks: readonly PageBlock[]): number {
  return new Set(blocks.flatMap((block) => block.sources?.map((source) => source.nodeId) ?? [])).size;
}

export function SpaceView({ route, onBack, onOpenPage, onOpenSource, changesPanel }: {
  route: Extract<SpaceRoute, { type: 'space' }>;
  onBack(): void;
  onOpenPage(route: OpenNativePageRoute): void;
  onOpenSource?: (source: BlockSource & { kind: 'chat' | 'helper' }) => void | boolean | Promise<void | boolean>;
  changesPanel?: React.ReactNode;
}) {
  const identity = { backendConnectionId: route.backendConnectionId, workspaceId: route.workspaceId };
  const { openPagePane, revealBackendNode } = useChatActions();
  const { projects } = useChatProjects();
  const nodes = useChatNodesSnapshot();
  const { pages, status: treeStatus, error: treeError, refresh: refreshTree } = useSpaceTree({ ...identity });
  const pageState = usePage({ ...identity, pageId: route.pageId });
  const page = pageState.page;
  const changes = pageState.changes ?? [];
  const archivedWorkspace = projects.some((project) => project.id === route.workspaceId && Boolean(project.archivedAt || project.deletedAt));
  const readOnly = archivedWorkspace || pageState.stale || pageState.status !== 'ready';
  const pageTree = React.useMemo(() => pageSpaceSubtree(pages ?? [], route.pageId), [pages, route.pageId]);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const targeting = useMetaChatTargeting();
  // Docked beside the chat window the page has half the area: databases take their narrow form, as in the beside-chat pane.
  const narrow = useMetaChatDocked();
  // Thread cards and a conflict's versions open their conversation the way the homes' rows do.
  const { openThread } = useHomeNavigation(route.backendConnectionId, route.pageId);
  // The Spaces sidebar carries the page tree; the outline (Move, headings) opens as a panel from the page menu.
  const [panel, setPanel] = React.useState<'pages' | 'maintenance' | 'components' | 'activity' | 'settings' | null>(null);
  const [menuAnchor, setMenuAnchor] = React.useState<HTMLElement | null>(null);
  const layoutRules = useLayoutRulesMenu({ pageId: route.pageId, backendConnectionId: route.backendConnectionId, readOnly });
  const [componentInsertAfter, setComponentInsertAfter] = React.useState<string | null | undefined>(undefined);

  const changePage = (pageId: string) => onOpenPage({ pageId, workspaceId: route.workspaceId, backendConnectionId: route.backendConnectionId });
  const pageActions = usePageActions({
    identity, pages: pageTree, readOnly,
    onOpen: changePage,
    onChanged: (id) => { refreshTree(); if (id === route.pageId) pageState.refresh(); },
    onTrashed: (target) => { if (pageIsWithin(pageTree, route.pageId, target.id)) onBack(); },
  });
  const { createChild, rename, move, trash } = pageActions;

  const applyEdits = async (ops: PageEditOp[], revision: number): Promise<'ok' | 'stale' | 'gone' | 'failed'> => {
    if (!page || pageState.stale || archivedWorkspace) return 'failed';
    if (page.revision !== revision) { pageState.refresh(); return 'stale'; }
    setBusy(true);
    try {
      await pageState.edit(ops);
      return 'ok';
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 409) { await pageState.refresh(); return 'stale'; }
      if (status === 404 || status === 410) return 'gone';
      return 'failed';
    } finally { setBusy(false); }
  };
  const insertComponent = async (component: PageComponent, version: number) => {
    if (readOnly || !page) return;
    setActionError(null);
    try {
      if (!component.enabled || !Number.isSafeInteger(version) || version < 1) throw new Error('Choose an enabled component version.');
      const detail = await readPageComponent(component.id, route.workspaceId, route.backendConnectionId, version);
      if (!detail.component?.enabled || detail.version.version !== version) throw new Error('This component version is no longer available. Refresh the library and try again.');
      const initialProps = defaultComponentProps(detail.version.propsSchema);
      const propsInput = window.prompt('Component properties (JSON object), validated against its saved schema.', JSON.stringify(initialProps, null, 2));
      if (propsInput === null) return;
      let requestedProps: unknown;
      try { requestedProps = JSON.parse(propsInput); }
      catch { throw new Error('Component properties must be valid JSON.'); }
      const props = isComponentRecord(requestedProps) ? validatePageComponentProps(detail.version.propsSchema ?? null, requestedProps) : null;
      if (!props) throw new Error('Component properties do not match the saved schema or size limit.');
      const heightInput = window.prompt(`Component height in pixels (${PAGE_COMPONENT_LIMITS.heightMin}–${PAGE_COMPONENT_LIMITS.heightMax}).`, '280');
      if (heightInput === null) return;
      const height = Number(heightInput);
      if (!Number.isSafeInteger(height) || height < PAGE_COMPONENT_LIMITS.heightMin || height > PAGE_COMPONENT_LIMITS.heightMax) {
        throw new Error(`Component height must be a whole number from ${PAGE_COMPONENT_LIMITS.heightMin} to ${PAGE_COMPONENT_LIMITS.heightMax}.`);
      }
      await pageState.edit([{
        op: 'insert',
        after: componentInsertAfter === undefined ? page.blocks.at(-1)?.id ?? null : componentInsertAfter,
        block: { type: 'component', componentId: component.id, pinnedVersion: version, props, height },
      }]);
      setComponentInsertAfter(undefined);
      setPanel(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not insert the component.');
    }
  };
  const renderDatabaseRef = (block: Extract<PageBlock, { type: 'database-ref' }>, compact = false, blockReadOnly = readOnly) => <>
    <NativeDatabase
    databaseId={block.databaseId}
    workspaceId={route.workspaceId}
    connectionId={route.backendConnectionId}
    viewId={block.viewId}
    compact={compact || narrow}
    readOnly={blockReadOnly || readOnly}
    presentation="page"
    onNavigatePage={changePage}
    onOpenSource={openExactSource}
    onAskDraft={(text) => {
      dispatchPageHelperDraft({
        ...identity,
        pageId: page?.id ?? route.pageId,
        text,
        blockContext: { blockId: block.id, title: `Database ${block.databaseId}`, content: 'Native database view' },
      });
    }}
    />
    <PageChangeTargets quiet changes={changes} target={{ kind: 'database', databaseId: block.databaseId }}
      onAccept={(change, edited) => { void pageState.accept(change.id, edited); }} onDismiss={onChange(pageState.dismiss)} onReopen={onChange(pageState.reopen)}
      onRevert={onChange(pageState.revert)} onRedo={onChange(pageState.redo)} onOpenSource={openChangeSource} loading={readOnly} error={pageState.error} />
  </>;
  // A task board needs the workspace's task database: made first, the first time.
  const { backendConnectionId, workspaceId } = route;
  const taskBoardEntry = React.useCallback((place: (block: { type: 'task-view' }) => Promise<unknown> | void): MichiMenuEntry => ({
    id: 'native-task-board', label: 'Task board', sub: 'Tasks from this workspace’s conversations', onSelect: () => {
      setActionError(null);
      void (async () => {
        try {
          await openTaskDatabase({ backendConnectionId, workspaceId });
          notifyPageChanged({ backendConnectionId, workspaceId });
          await place({ type: 'task-view' });
        } catch (error) {
          setActionError(error instanceof Error ? error.message : 'Could not add the task board.');
        }
      })();
    },
  }), [backendConnectionId, workspaceId]);
  const slotAddEntries = React.useCallback((insert: (block: MichiPageBlock) => void): MichiMenuEntry[] => (readOnly ? [] : [taskBoardEntry(insert)]), [readOnly, taskBoardEntry]);
  const addEntries = React.useCallback((afterId: string, _anchor: HTMLElement | null): MichiMenuEntry[] => readOnly ? [] : [{
    id: 'native-component', label: 'Add component', sub: 'Insert a saved workspace component', onSelect: () => {
      setComponentInsertAfter(afterId || null);
      setPanel('components');
    },
  }, {
    id: 'native-database-ref', label: 'Add database', sub: 'Create or link a database', onSelect: () => {
      const action = window.prompt('Type “new” to create a database, or enter the ID or title of a database in this workspace to link it.');
      if (!action) return;
      void (async () => {
        try {
          let databaseId = action.trim();
          if (databaseId.toLowerCase() === 'new') {
            const title = window.prompt('Name this database', 'New database');
            if (!title?.trim()) return;
            const created = await createWorkspaceDatabase(route.workspaceId, { title: title.trim() }, identity);
            databaseId = created.database.id;
          } else {
            const databases = await listWorkspaceDatabases(route.workspaceId, identity);
            const database = databases.find((candidate) => candidate.id === databaseId || candidate.title.toLowerCase() === databaseId.toLowerCase());
            if (!database) { setActionError('Choose a database ID or title from this workspace.'); return; }
            databaseId = database.id;
          }
          await pageState.edit([{ op: 'insert', block: { type: 'database-ref', databaseId }, after: afterId }]);
        } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not add the database reference.'); }
      })();
    },
  }, taskBoardEntry((block) => pageState.edit([{ op: 'insert', block, after: afterId || null }]))], [identity, pageState, readOnly, route.workspaceId, taskBoardEntry]);
  const blockTarget = (block: PageBlock) => {
    const title = block.type === 'heading' ? block.text : block.type === 'callout' ? block.title || 'Callout' : block.type === 'checklist' ? block.title || 'Checklist' : block.type === 'database-ref' ? 'Database' : block.type === 'page-link' ? 'Linked page' : 'Page section';
    const content = block.type === 'heading' || block.type === 'markdown' || block.type === 'callout' ? block.text : block.type === 'checklist' ? block.items.map((item) => `${item.done ? '[x]' : '[ ]'} ${item.text}`).join('\n') : '';
    return { ...identity, pageId: route.pageId, blockId: block.id, title, content };
  };
  const askAssistant = (block: PageBlock, item?: { index: number; text: string }) => targeting?.askAbout(item ? blockItemTarget(blockTarget(block), item) : blockTarget(block));
  const selectBlock = (selection: { blockId: string } | null) => {
    const block = selection ? page?.blocks.find((candidate) => candidate.id === selection.blockId) : undefined;
    targeting?.setTarget(block ? blockTarget(block) : null);
  };
  const targetIds = targeting?.target && targeting.target.pageId === route.pageId ? [targeting.target.blockId] : [];
  const openExactSource = (source: { kind: 'chat' | 'helper'; nodeId: string; turnId: string; assistantId: string }) => {
    // Provenance records how the source was created. Its current page binding
    // decides whether it still lives in an embedded helper or was promoted.
    const sourceNode = nodes[source.nodeId];
    const sourcePageId = sourceNode
      ? sourceNode.projectId === route.workspaceId ? sourceNode.pageId ?? null : null
      : (pages ?? []).find((candidate) => candidate.helperNodeId === source.nodeId)?.id ?? null;
    const current = { ...source, kind: sourcePageId ? 'helper' as const : 'chat' as const };
    if (onOpenSource) return Promise.resolve(onOpenSource(current)).then((result) => result !== false);
    return revealPageSource(identity, current, revealBackendNode);
  };
  const openChangeSource = (source: { kind: 'chat' | 'helper'; nodeId: string; turnId: string; assistantId: string }) => openExactSource(source);
  const onChange = (action: (changeId: string) => Promise<unknown> | void) => (change: PageChangeDto) => { void action(change.id); };
  const renderComponent = React.useCallback((block: PageBlock) => block.type === 'component' && page ? (
    <CustomBlock
      block={block}
      pageId={page.id}
      workspaceId={route.workspaceId}
      connectionId={route.backendConnectionId}
      readOnly={readOnly}
      onNavigatePage={changePage}
      onOpenSource={openExactSource}
      onAskDraft={(text) => {
        dispatchPageHelperDraft({
          ...identity,
          pageId: page.id,
          text,
          blockContext: { blockId: block.id, title: `Component ${block.componentId}`, content: 'Custom page component' },
        });
      }}
    />
  ) : null, [changePage, openExactSource, page, readOnly, route.backendConnectionId, route.workspaceId]);
  const renderThreads = React.useCallback((block: Extract<PageBlock, { type: 'threads' }>) => <LiveThreadCards block={block} connectionId={route.backendConnectionId} workspaceId={route.workspaceId}
    onOpen={(card) => { openThread({ nodeId: card.nodeId, workspaceId: card.workspaceId, messageId: card.messageId }); }} />,
  [openThread, route.backendConnectionId, route.workspaceId]);
  // A conversation a block names may have moved or gone since; the backend says where it is, or that it is gone.
  const openConversation = React.useCallback((nodeId: string) => { void openThread({ nodeId, workspaceId: null }); }, [openThread]);
  const renderTaskView = (block: { viewId?: string; title?: string }, compact = false, blockReadOnly = readOnly) => (
    <NativeTaskView
      workspaceId={route.workspaceId}
      connectionId={route.backendConnectionId}
      viewId={block.viewId}
      title={block.title}
      compact={compact || narrow}
      readOnly={blockReadOnly || readOnly}
      onOpenThread={(item) => { void openThread({ nodeId: item.nodeId, workspaceId: item.workspaceId, messageId: item.messageId }); }}
      onNavigatePage={changePage}
      onOpenSource={openExactSource}
    />
  );

  const rootId = pageTree.find((candidate) => !candidate.parentId || !pageTree.some((other) => other.id === candidate.parentId))?.id ?? null;
  const root = pageTree.find((candidate) => candidate.id === rootId) ?? null;
  const workspaceName = projects.find((project) => project.id === route.workspaceId)?.name ?? 'workspace';
  const sourceLabel = React.useCallback((source: PageChangeDto['source']) => {
    if (source.kind === 'chat' || source.kind === 'helper') {
      const title = nodes[source.nodeId]?.title?.trim();
      return title || (source.kind === 'helper' ? 'page assistant' : undefined);
    }
    if (source.kind === 'maintenance') return 'conversation maintenance';
    return undefined;
  }, [nodes]);
  const openBeside = React.useCallback(() => {
    if (!page) return;
    openPagePane({ pageId: route.pageId, workspaceId: route.workspaceId, backendConnectionId: route.backendConnectionId, title: page.title });
  }, [openPagePane, page, route.backendConnectionId, route.pageId, route.workspaceId]);
  React.useEffect(() => {
    if (!page) return undefined;
    publishSpaceTopbar({ title: page.title || 'Untitled page', onOpenBeside: openBeside });
    return undefined;
  }, [openBeside, page]);
  React.useEffect(() => () => publishSpaceTopbar(null), []);
  const { spaces } = useSpaces(route.backendConnectionId);
  const conversationScope = React.useMemo(() => ({
    backendConnectionId: route.backendConnectionId,
    pageId: route.pageId,
    workspaceId: route.workspaceId,
    workspaceName,
    pageTitle: page?.title || 'Untitled page',
  }), [page?.title, route.backendConnectionId, route.pageId, route.workspaceId, workspaceName]);
  const startConversation = React.useCallback((text: string, workspaceId: string) => { openNewChatSheet({ text, workspaceId }); }, []);

  const shell = { layout: 'column' as const, className: 'space-doc spaces-home spaces-space', columnClassName: 'spaces-home__doc' };
  if (pageState.status === 'loading' && !page) return <DocumentShell label="Page" {...shell} busy><div className="michi-doc-skeleton" aria-hidden="true"><span style={{ width: 120, height: 10 }} /><span style={{ width: '46%', height: 24 }} /><span style={{ width: '62%' }} /><span style={{ width: '100%', height: 64 }} /></div><p className="space-doc__status" role="status">Loading page…</p></DocumentShell>;
  if (pageState.status === 'error' && !page) return <DocumentShell label="Page" {...shell}><p className="michi-doc-unknown michi-doc-retry" role="alert">{pageState.error || 'This page could not be loaded.'} <button type="button" className="michi-doc-link-btn" onClick={pageState.refresh}>Retry</button> <button type="button" className="michi-doc-link-btn" onClick={onBack}>All Pages</button></p></DocumentShell>;
  if (!page) return <DocumentShell label="Page" {...shell}><p className="michi-doc-unknown" role="alert">This page is unavailable. It may have been deleted or disconnected from its backend. <button type="button" className="michi-doc-link-btn" onClick={onBack}>All Pages</button></p></DocumentShell>;

  const isRoot = page.id === rootId;
  const summary = isRoot ? spaces?.find((space) => space.id === page.id) ?? null : null;
  const caption = isRoot ? spaceCaption(workspaceName, summary?.createdBy) : `Page · ${root?.title ?? workspaceName}`;
  const meta = spaceMetaLine({
    pagesInside: isRoot ? Math.max(0, pageTree.length - 1) : null,
    parentTitle: isRoot ? null : root?.title ?? null,
    // A Space counts the conversations that wrote anywhere in it; a page inside, those whose words are on it.
    conversations: summary ? summary.contributorNodeIds.length : isRoot && !spaces ? null : blockSourceCount(page.blocks),
    updatedAt: page.updatedAt,
    state: pageState.stale ? 'connection unavailable · edits paused' : busy ? 'saving…' : null,
  });
  const panelHeader = (title: string) => <header className="space-panel__head"><span className="michi-doc-caption">{title}</span><button type="button" className="michi-doc-link-btn" onClick={() => setPanel(null)}>Close</button></header>;

  if (panel === 'settings' && !readOnly) return <DocumentShell label={`${page.title} settings`} {...shell}>
    <SpaceSettings key={page.id} page={page} connectionId={route.backendConnectionId} spaceId={rootId ?? page.id} spaceTitle={root?.title ?? page.title}
      onBack={() => setPanel(null)} onComponents={() => setPanel('components')} onRename={async (title) => {
        await patchPage(page.id, { title, revision: page.revision }, identity);
        pageState.refresh(); refreshTree(); notifyPageChanged({ ...identity, pageId: page.id });
      }} />
  </DocumentShell>;

  return <DocumentShell
    label={page.title || 'Untitled page'}
    {...shell}
    after={menuAnchor && <MichiMenu
      anchor={menuAnchor}
      label="Page actions"
      width={232}
      align="end"
      entries={[
        { id: 'settings', label: 'Settings', disabled: readOnly, onSelect: () => setPanel('settings') },
        { id: 'rename', label: 'Rename', disabled: readOnly, onSelect: () => { const summary = pageTree.find((item) => item.id === page.id); if (summary) void rename(summary); } },
        { id: 'child', label: 'Add a page inside', disabled: readOnly, onSelect: () => void createChild(page.id) },
        { id: 'beside', label: 'Open beside chat', onSelect: openBeside },
        { id: 'pages', label: 'Page outline', sub: 'Move pages and jump to headings', onSelect: () => setPanel('pages') },
        { divider: true, id: 'd1' },
        { id: 'maintenance', label: 'Conversation maintenance', sub: 'Keep this page up to date', disabled: readOnly, onSelect: () => setPanel('maintenance') },
        layoutRules.entry(menuAnchor),
        { id: 'components', label: 'Components', sub: 'Insert a saved component', disabled: readOnly, onSelect: () => { setComponentInsertAfter(page.blocks.at(-1)?.id ?? null); setPanel('components'); } },
        { id: 'activity', label: 'Activity', sub: changes.length ? `${changes.length} changes` : undefined, onSelect: () => setPanel('activity') },
        { divider: true, id: 'd2' },
        { id: 'trash', label: isRoot ? 'Move page to trash' : 'Move to trash', danger: true, disabled: readOnly, onSelect: () => { const summary = pageTree.find((item) => item.id === page.id); if (summary) void trash(summary); } },
      ]}
      onClose={(restore) => { const anchor = menuAnchor; setMenuAnchor(null); if (restore) anchor.focus({ preventScroll: true }); }}
    />}
  >
    {pageActions.dialog}
    <NewChatSheetSlot scope={conversationScope} />
    {layoutRules.popover}
    <header className="spaces-home__head">
      <p className="area-settings__kicker">{caption}</p>
      <div className="spaces-home__title-row michi-doc-title-row">
        <h1 className="spaces-home__title">{page.title || 'Untitled page'}</h1>
        <span className="spaces-home-spacer" />
        {!readOnly && <button type="button" className="michi-doc-title__open" aria-label="Page settings" onClick={() => setPanel('settings')}><Settings2 size={16} strokeWidth={1.6} /></button>}
        <button type="button" className="michi-doc-title__open space-doc__menu" aria-label="Page actions" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)} onClick={(event) => setMenuAnchor(menuAnchor ? null : event.currentTarget)}><MoreHorizontal size={16} strokeWidth={1.6} /></button>
      </div>
      <p className="michi-doc-meta space-doc__source"><Sparkles size={12} strokeWidth={1.7} aria-hidden="true" /><span>{meta}</span></p>
    </header>
    {(pageState.error || actionError) && <p className="space-doc__notice" role="alert">{actionError || pageState.error} <button type="button" className="michi-doc-link-btn" onClick={() => { setActionError(null); pageState.refresh(); }}>Retry</button></p>}
    {pageState.stale && <p className="space-doc__notice" role="status">This page is showing its last saved version. Reconnect and retry before editing.</p>}
    {archivedWorkspace && <p className="space-doc__notice" role="status">This workspace is archived. The page is read-only.</p>}
    <PageProgressCards scope={conversationScope} />
    {changesPanel}
    {panel === 'pages' && <section className="space-panel space-panel--pages" aria-label="Page outline">{panelHeader('Page outline')}<SpaceOutline
      pages={pageTree}
      activePageId={page.id}
      rootId={rootId}
      blocks={page.blocks}
      readOnly={archivedWorkspace || pageState.stale}
      loading={treeStatus === 'loading'}
      error={treeStatus === 'error' ? treeError : null}
      onRetry={refreshTree}
      onOpen={changePage}
      onCreateChild={(parentId) => void createChild(parentId)}
      onRename={(target) => void rename(target)}
      onMove={(target) => void move(target)}
      onTrash={(target) => void trash(target)}
    /></section>}
    {panel === 'maintenance' && !readOnly && <section className="space-panel" aria-label="Conversation maintenance">{panelHeader('Conversation maintenance')}<MaintenanceStatus backendConnectionId={route.backendConnectionId} workspaceId={route.workspaceId} spaceId={rootId ?? page.id} spaceTitle={root?.title ?? page.title} pendingProposals={page.pendingProposals} /></section>}
    {panel === 'components' && !readOnly && <section className="space-panel space-panel--components" aria-label="Components"><ComponentLibrary workspaceId={route.workspaceId} connectionId={route.backendConnectionId} onClose={() => setPanel(null)} onInsertBlock={async (block) => {
      const result = await applyEdits([{ op: 'insert', block, after: componentInsertAfter === undefined ? page.blocks.at(-1)?.id ?? null : componentInsertAfter }], page.revision);
      if (result !== 'ok') throw new Error('Could not add this component. Refresh the page and try again.');
      setPanel(null);
    }} onInsert={(component, version) => insertComponent(component, version)} onOpenSource={openExactSource} /></section>}
    {panel === 'activity' && <section className="space-panel" aria-label="Activity">{panelHeader('Activity')}<PageChanges changes={changes} onAccept={(change, edited) => { void pageState.accept(change.id, edited); }} onDismiss={onChange(pageState.dismiss)} onReopen={onChange(pageState.reopen)} onRevert={onChange(pageState.revert)} onRedo={onChange(pageState.redo)} onRevertBatch={(batchId) => pageState.revertBatch(batchId)} onOpenSource={openChangeSource} loading={readOnly} error={pageState.error} hasMore={pageState.hasMoreChanges} onLoadMore={pageState.loadMoreChanges} /></section>}
    <NativePageDocument page={page} onEdit={applyEdits} onOpenPage={changePage} onOpenSource={(source) => openExactSource({ kind: 'chat', ...source })} sourceLabel={(source) => sourceLabel({ kind: 'chat', ...source })} onAskAssistant={readOnly || !targeting ? undefined : askAssistant} onSelectionChange={readOnly || !targeting ? undefined : selectBlock} selectedBlockIds={targetIds} selectOnClick={!!targeting} renderDatabaseRef={renderDatabaseRef} renderComponent={renderComponent} renderThreads={renderThreads} renderTaskView={renderTaskView} onOpenConversation={openConversation} onStartConversation={readOnly ? undefined : startConversation} renderDecorations={(block) => page ? <><PageChangeTargets quiet changes={changes} target={{ kind: 'block', pageId: page.id, blockId: block.id }} sourceLabel={sourceLabel} onAccept={(change, edited) => { void pageState.accept(change.id, edited); }} onDismiss={onChange(pageState.dismiss)} onReopen={onChange(pageState.reopen)} onRevert={onChange(pageState.revert)} onRedo={onChange(pageState.redo)} onOpenSource={openChangeSource} loading={readOnly} error={pageState.error} /></> : null} addEntries={addEntries} slotAddEntries={slotAddEntries} readOnly={readOnly} />
  </DocumentShell>;
}

export default SpaceView;
