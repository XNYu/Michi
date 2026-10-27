import React, { useCallback } from 'react';
import type { BlockSource, PageBlock, PageChangeDto, PageEditOp, PageSummaryDto } from 'michi-shared';
import type { PagePaneItem } from '../../../state/paneItems';
import { useChatActions, useChatProjects, useChatNodesSnapshot } from '../../../state/chatStore';
import { usePage } from '../../../state/pages/usePage';
import { revealPageSource } from '../../../state/pages/revealSource';
import { useSpaceTree } from '../../../state/pages/useSpaceTree';
import { backendConnectionIdForWorkspace } from '../../../config/backendConnections';
import NativePageDocument from './NativePageDocument';
import NativeDatabase from './NativeDatabase';
import { NativeTaskView } from './NativeTaskView';
import { PageChangeTargets } from './PageChangeTargets';
import { DocumentHeader, DocumentShell } from '../content/page/DocumentShell';
import { pageBackground } from '../../../lib/pageBackground';
import { Maximize2 } from 'lucide-react';
import { toast } from 'sonner';
import { CustomBlock } from './components/CustomBlock';
import { openNativePageRoute } from './SpacesPage';
import { dispatchPageHelperDraft } from '../../../state/pages/pageHelperDraft';
import { LiveThreadCards } from './NativeThreadCards';
import './spaces.css';

export function PagePane({ item }: { item: PagePaneItem }) {
  const { projects } = useChatProjects();
  const { revealBackendNode } = useChatActions();
  const nodes = useChatNodesSnapshot();
  const host = projects.find((project) => project.id === item.projectId);
  const owner = projects.find((project) => project.id === item.workspaceId);
  const pageState = usePage({
    backendConnectionId: item.backendConnectionId,
    workspaceId: item.workspaceId,
    pageId: item.pageId,
  });
  const { pages } = useSpaceTree({ backendConnectionId: item.backendConnectionId, workspaceId: item.workspaceId });
  const page = pageState.page;
  const changes = pageState.changes ?? [];
  const ownerArchived = owner?.archivedAt != null || owner?.deletedAt != null;
  const readOnly = ownerArchived || !owner || pageState.status !== 'ready' || pageState.stale;
  const readOnlyReason = ownerArchived
    ? 'This workspace is archived or deleted. The page is read-only.'
    : !owner
      ? 'This page’s workspace is unavailable here. The page is read-only.'
      : pageState.stale || pageState.status !== 'ready'
        ? 'This page is out of date. Reconnect before editing.'
        : null;
  const openStandalone = useCallback(() => openNativePageRoute({
    pageId: item.pageId,
    workspaceId: item.workspaceId,
    backendConnectionId: item.backendConnectionId,
  }), [item.backendConnectionId, item.pageId, item.workspaceId]);
  const onOpenSource = useCallback((source: BlockSource) => {
    if (!page) return false;
    const sourceNode = nodes[source.nodeId];
    const sourcePageId = sourceNode
      ? sourceNode.projectId === item.workspaceId ? sourceNode.pageId ?? null : null
      : (pages ?? []).find((candidate) => candidate.helperNodeId === source.nodeId)?.id ?? null;
    const kind = sourcePageId ? 'helper' : 'chat';
    return revealPageSource(
      { backendConnectionId: item.backendConnectionId, workspaceId: item.workspaceId },
      { ...source, kind },
      revealBackendNode,
      sourcePageId ? {
        pageId: sourcePageId,
        open: () => openNativePageRoute({
          pageId: sourcePageId,
          workspaceId: item.workspaceId,
          backendConnectionId: item.backendConnectionId,
        }),
      } : undefined,
    );
  }, [item.backendConnectionId, item.workspaceId, nodes, openStandalone, page, pages, revealBackendNode]);
  const onEdit = useCallback(async (ops: PageEditOp[], revision: number): Promise<'ok' | 'stale' | 'gone' | 'failed'> => {
    if (!page || readOnly) return 'failed';
    if (page.revision !== revision) { pageState.refresh(); return 'stale'; }
    try {
      await pageState.edit(ops);
      return 'ok';
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 409) { pageState.refresh(); return 'stale'; }
      if (status === 404 || status === 410) return 'gone';
      return 'failed';
    }
  }, [page, pageState.edit, pageState.refresh, readOnly]);
  const onOpenPage = useCallback((pageId: string) => openNativePageRoute({
    pageId,
    workspaceId: item.workspaceId,
    backendConnectionId: item.backendConnectionId,
  }), [item.backendConnectionId, item.workspaceId]);
  const handoffDraft = useCallback((text: string, blockContext?: { blockId: string; title: string; content: string }) => {
    dispatchPageHelperDraft({
      backendConnectionId: item.backendConnectionId,
      workspaceId: item.workspaceId,
      pageId: item.pageId,
      text,
      ...(blockContext ? { blockContext } : {}),
    });
    openStandalone();
  }, [item.backendConnectionId, item.pageId, item.workspaceId, openStandalone]);
  const renderDatabaseRef = useCallback((block: Extract<PageBlock, { type: 'database-ref' }>) => (
    <>
      <NativeDatabase
        databaseId={block.databaseId}
        workspaceId={item.workspaceId}
        connectionId={item.backendConnectionId}
        viewId={block.viewId}
        compact
        readOnly={readOnly}
        onNavigatePage={onOpenPage}
        onOpenSource={onOpenSource}
        onAskDraft={(text) => handoffDraft(text, {
          blockId: block.id,
          title: `Database ${block.databaseId}`,
          content: 'Native database view',
        })}
      />
      <PageChangeTargets changes={changes} target={{ kind: 'database', databaseId: block.databaseId }}
        onAccept={(change, edited) => { void pageState.accept(change.id, edited); }}
        onDismiss={(change) => { void pageState.dismiss(change.id); }} onReopen={(change) => { void pageState.reopen(change.id); }}
        onRevert={(change) => { void pageState.revert(change.id); }} onRedo={(change) => { void pageState.redo(change.id); }}
        onOpenSource={onOpenSource} loading={readOnly} error={pageState.error} />
    </>
  ), [changes, handoffDraft, item.backendConnectionId, item.workspaceId, onOpenPage, onOpenSource, pageState.accept, pageState.dismiss, pageState.error, pageState.redo, pageState.reopen, pageState.revert, readOnly]);
  const renderComponent = useCallback((block: PageBlock) => block.type === 'component' ? (
    <CustomBlock
      block={block}
      pageId={item.pageId}
      workspaceId={item.workspaceId}
      connectionId={item.backendConnectionId}
      readOnly={readOnly}
      onNavigatePage={onOpenPage}
      onOpenSource={onOpenSource}
      onAskDraft={(text) => handoffDraft(text, {
        blockId: block.id,
        title: `Component ${block.componentId}`,
        content: 'Custom page component',
      })}
    />
  ) : null, [handoffDraft, item.backendConnectionId, item.pageId, item.workspaceId, onOpenPage, onOpenSource, readOnly]);

  const paneIdentity = {
    'data-native-page-pane': '',
    'data-page-id': item.pageId,
    'data-workspace-id': item.workspaceId,
    'data-backend-connection-id': item.backendConnectionId,
  } as const;
  if (pageState.status === 'loading' && !page) return <section className="page-pane" aria-label="Native Page" {...paneIdentity}><p role="status">Loading page…</p></section>;
  if (pageState.status === 'error' && !page) return <section className="page-pane" aria-label="Native Page" {...paneIdentity}><p className="spaces-error" role="alert">{pageState.error || 'This page could not be loaded.'}</p><button type="button" className="spaces-secondary" onClick={pageState.refresh}>Retry</button></section>;
  if (!page) return <section className="page-pane" aria-label="Native Page" {...paneIdentity}><p role="alert">This page is unavailable.</p></section>;

  const ownerName = owner?.name || item.workspaceId;
  const isCrossWorkspace = item.projectId !== item.workspaceId
    || backendConnectionIdForWorkspace(item.projectId) !== item.backendConnectionId;
  const pagePath: string[] = [];
  let pathPage: PageSummaryDto | null = page;
  const byId = new Map((pages ?? []).map((entry) => [entry.id, entry]));
  const visited = new Set<string>();
  while (pathPage && !visited.has(pathPage.id)) {
    visited.add(pathPage.id);
    pagePath.unshift(pathPage.title || 'Untitled page');
    pathPage = pathPage.parentId ? byId.get(pathPage.parentId) ?? null : null;
  }
  const rootTitle = pagePath.length > 1 ? pagePath[0] : null;
  const sourceLabel = (source: PageChangeDto['source']) => ('nodeId' in source ? nodes[source.nodeId]?.title?.trim() : undefined) || undefined;
  return (
    <section
      className="page-pane"
      aria-label={page.title || 'Untitled page'}
      {...paneIdentity}
    >
      <header className="page-pane-header">
        <div className="page-pane-heading">
          <span className="page-pane-tag">Page</span>
          <strong title={pagePath.join(' / ')}>{page.title || 'Untitled page'}</strong>
          <span className="page-pane-visibility">· {isCrossWorkspace ? `Belongs to ${ownerName}` : `${host?.name || ownerName} chats can read and write this`}</span>
        </div>
        <div className="page-pane-actions">
          <button type="button" className="space-helper-icon" onClick={openStandalone} aria-label="Open standalone" title="Open standalone"><Maximize2 size={14} strokeWidth={1.6} /></button>
        </div>
      </header>
      {readOnlyReason && <p className="page-pane-notice" role="status">{readOnlyReason}</p>}
      {pageState.error && <p className="page-pane-notice" role="alert">{pageState.error}</p>}
      <DocumentShell label={`${page.title || 'Untitled page'} document`} compact background={pageBackground('space')}>
        <DocumentHeader caption={rootTitle ? `Page · ${rootTitle}` : `Page · ${ownerName}`} title={page.title || 'Untitled page'} />
        <NativePageDocument
          page={page}
          onEdit={onEdit}
          onOpenPage={onOpenPage}
          onOpenSource={onOpenSource}
          renderDatabaseRef={renderDatabaseRef}
          renderDecorations={(block) => <PageChangeTargets changes={changes} target={{ kind: 'block', pageId: page.id, blockId: block.id }} sourceLabel={sourceLabel}
            onAccept={(change, edited) => { void pageState.accept(change.id, edited); }}
            onDismiss={(change) => { void pageState.dismiss(change.id); }} onReopen={(change) => { void pageState.reopen(change.id); }}
            onRevert={(change) => { void pageState.revert(change.id); }} onRedo={(change) => { void pageState.redo(change.id); }}
            onOpenSource={onOpenSource} loading={readOnly} error={pageState.error} />}
          renderComponent={renderComponent}
          renderThreads={(block) => <LiveThreadCards block={block} connectionId={item.backendConnectionId} workspaceId={item.workspaceId}
            onOpen={(card) => { void revealBackendNode(card.workspaceId, card.nodeId); }} />}
          renderTaskView={(block, _compact, blockReadOnly) => <NativeTaskView workspaceId={item.workspaceId} connectionId={item.backendConnectionId}
            viewId={block.viewId} title={block.title} compact readOnly={blockReadOnly || readOnly}
            onOpenThread={(card) => { void revealBackendNode(card.workspaceId, card.nodeId); }} onNavigatePage={onOpenPage} onOpenSource={onOpenSource} />}
          onOpenConversation={(nodeId) => { void revealBackendNode(item.workspaceId, nodeId).then((opened) => { if (!opened) toast.error('This conversation is no longer in this workspace.'); }); }}
          compact
          readOnly={readOnly}
        />
      </DocumentShell>
    </section>
  );
}

export default PagePane;
