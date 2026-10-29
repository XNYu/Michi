import { NativeHomeSection } from './home/NativeHomeSection';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Copy, EyeOff, Quote, Sparkles, SquareCheck } from 'lucide-react';
import type { BlockSource, PageBlock, PageDto, PageEditOp } from 'michi-shared';
import { BlockFrame, type ApplyResult, type OrphanDraft, type PageChrome } from '../content/page/BlockFrame';
import { MichiBlock } from '../content/page/MichiBlock';
import { PageChangedNote, TextBlockEditor } from '../content/page/BlockEditor';
import type { MichiMenuEntry } from '../content/page/MichiMenu';
import type { MichiPageBlock } from 'michi-shared';
import type { MichiPageEditOp } from '../content/page/editorTypes';
import type { MichiBlockCtx } from '../content/page/blockTypes';
import { toggledChecklist } from '../content/page/pageEdits';
import { pageBlockText, pageBlockTitle, pageSegmentSources } from 'michi-shared';
import { toMichiBlock, toNativePageOps } from './nativeBlockAdapter';
import { useBlockDecisions } from './useBlockDecisions';
import { usePageBlockDrag } from './usePageBlockDrag';
import './nativeBlocks.css';
import { MichiMantine } from '../content/page/mantine/MichiMantine';
import { PageBlocksContext } from '../content/page/vendor-blocks/src/desk/blocks/catalog/text/outline';
import type { PageBlockWithSources } from '../content/page/vendor-blocks/shared/desk-blocks';
import { useMetaChatTargeting } from './metaChat/SpacesMetaChat';
import { backendConnectionIdForWorkspace } from '../../../config/backendConnections';
import { NativeMarkdownSegments, nativeSourceRows } from './NativeMarkdownSegments';
import { PageViewEntry, PageViewHost } from '../content/page/PageViewContext';

export interface NativePageDocumentProps {
  page: PageDto;
  /** Home may place segments around native sections; edits still use the full page. */
  visibleBlocks?: readonly PageBlock[];
  sourceLabel?(source: BlockSource): string | undefined;
  onEdit(ops: PageEditOp[], revision: number): Promise<ApplyResult>;
  onOpenPage(pageId: string): void;
  onOpenSource?(source: BlockSource): void | boolean | Promise<void | boolean>;
  onAsk?(block: PageBlock, question: string): void;
  /** Set: Ask hands the block to the assistant window instead of asking for a question. */
  onAskAssistant?(block: PageBlock): void;
  /** A plain click on a block toggles its selection. */
  selectOnClick?: boolean;
  renderDatabaseRef(block: Extract<PageBlock, { type: 'database-ref' }>, compact?: boolean, readOnly?: boolean): React.ReactNode;
  renderDecorations?(block: PageBlock): React.ReactNode;
  onOrphanDraft?(draft: OrphanDraft): void;
  compact?: boolean;
  readOnly?: boolean;
  onSelectBlock?(block: PageBlock, mode: 'toggle' | 'extend'): void;
  selectedBlockIds?: readonly string[];
  onSelectionChange?(selection: { blockId: string; title: string; content: string } | null): void;
  renderComponent?(block: PageBlock): React.ReactNode;
  /** Thread cards: the conversations a block names, with their live state. */
  renderThreads?(block: Extract<PageBlock, { type: 'threads' }>): React.ReactNode;
  /** Task boards: the page's workspace's task database in the view a `task-view` block names, at the top or inside a container. */
  renderTaskView?(block: { viewId?: string; title?: string }, compact?: boolean, readOnly?: boolean): React.ReactNode;
  addEntries?(afterId: string, anchor: HTMLElement | null): MichiMenuEntry[];
  /** What the "+" at the foot of a container's section offers (a task board); `insert` puts a block last in that section. */
  slotAddEntries?(insert: (block: MichiPageBlock) => void): MichiMenuEntry[];
  /** Set: each next step offers "Start a conversation" with its text, in this page's workspace. */
  onStartConversation?(text: string, workspaceId: string): void;
  /** Opens a conversation a block names (a conflict's version); without it the name is plain text. */
  onOpenConversation?(nodeId: string): void;
}

const clipboard = async (text: string) => {
  try { await navigator.clipboard.writeText(text); } catch { /* Clipboard access is optional in embedded panes. */ }
};

/** What a native block's Copy puts on the clipboard: the block as the block catalog writes it. */
function nativeText(block: PageBlock | undefined): string {
  return block ? pageBlockText(block) : '';
}

/** Native Page renderer backed by the same editors/chrome as the Michi page. */
export function NativePageDocument(props: NativePageDocumentProps) {
  const identity = JSON.stringify([backendConnectionIdForWorkspace(props.page.workspaceId), props.page.workspaceId, props.page.id]);
  return <PageViewHost key={identity} page={props.page} renderBlocks={ids => <>
    {ids.some(id => !props.page.blocks.some(block => block.id === id)) && <p role="status">Some content in this view is no longer available.</p>}
    <NativePageDocumentContent {...props}
      visibleBlocks={ids.flatMap(id => { const block = props.page.blocks.find(block => block.id === id); return block ? [block] : []; })} detailView />
  </>}>
    <NativePageDocumentContent {...props} />
  </PageViewHost>;
}

function NativePageDocumentContent({
  page,
  visibleBlocks = page.blocks,
  sourceLabel,
  onEdit,
  onOpenPage,
  onOpenSource,
  onAsk,
  onAskAssistant,
  selectOnClick = false,
  renderDatabaseRef,
  renderDecorations,
  onOrphanDraft,
  compact = false,
  readOnly = false,
  onSelectBlock,
  selectedBlockIds,
  onSelectionChange,
  renderComponent,
  renderThreads,
  renderTaskView,
  addEntries,
  slotAddEntries,
  onStartConversation,
  onOpenConversation,
  detailView = false,
}: NativePageDocumentProps & { detailView?: boolean }) {
  const targeting = useMetaChatTargeting();
  const instanceId = useId();
  const documentRef = useRef<HTMLDivElement>(null);
  const drag = usePageBlockDrag(page, documentRef, onEdit, readOnly || detailView);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionPending = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const perform = useCallback(async (ops: PageEditOp[]) => {
    if (readOnly || actionPending.current) return;
    actionPending.current = true;
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await onEdit(ops, page.revision);
      if (result !== 'ok') setActionError(result === 'stale' ? 'The page changed. Try again.' : 'Could not save this change. Try again.');
    } catch { setActionError('Could not save this change. Try again.'); }
    finally { actionPending.current = false; setActionBusy(false); }
  }, [onEdit, page.revision, readOnly]);
  // A tick, pick or kept version shows at once and saves in order; the page catches up with the block it makes.
  const { display: decided, decide: updateBlock, note: decisionNote } = useBlockDecisions(page, onEdit, readOnly);
  const michiBlocks = useMemo(() => visibleBlocks.map((block) => decided(block.id) ?? toMichiBlock(block)), [visibleBlocks, decided]);
  const [internalSelection, setInternalSelection] = useState<string[]>([]);
  const activeSelection = selectedBlockIds ?? internalSelection;
  const nativeById = useMemo(() => new Map(page.blocks.map((block) => [block.id, block])), [page.blocks]);
  const toggleItem = useCallback((display: MichiPageBlock, index: number) => {
    const next = toggledChecklist(display, index);
    if (next) updateBlock(display, next);
  }, [updateBlock]);

  const apply = useCallback(async (ops: MichiPageEditOp[], _label: string, observedRevision?: number): Promise<ApplyResult> => {
    if (readOnly) return 'failed';
    const insertCount = ops.filter((op) => op.op === 'insert').length;
    if (page.blocks.length + insertCount > 40) return 'failed';
    const nativeOps = toNativePageOps(ops, page);
    if (!nativeOps?.length) return 'failed';
    try {
      return await onEdit(nativeOps, observedRevision ?? page.revision);
    } catch {
      return 'failed';
    }
  }, [onEdit, page, readOnly]);

  const select = useCallback((id: string, mode: 'toggle' | 'extend') => {
      const block = nativeById.get(id);
      if (!block) return;
      onSelectBlock?.(block, mode);
      const next = mode === 'toggle'
        ? (activeSelection.includes(id) ? activeSelection.filter((value) => value !== id) : [...activeSelection, id])
        : [...activeSelection, id];
      if (selectedBlockIds === undefined) setInternalSelection(next);
      const selected = next.length ? nativeById.get(next[next.length - 1]) : undefined;
      onSelectionChange?.(selected ? { blockId: selected.id, title: selectionTitle(selected), content: pageBlockText(selected) } : null);
    }, [activeSelection, nativeById, onSelectBlock, onSelectionChange, selectedBlockIds]);

  const chrome = useMemo<PageChrome>(() => ({
    projectId: page.workspaceId,
    generatedAt: page.revision,
    capabilities: { ask: Boolean(onAsk || onAskAssistant), branch: false, sources: Boolean(onOpenSource), copyLink: false, select: true, drag: !compact && !detailView },
    ask: (michiBlock, question) => {
      const native = michiBlock.id ? nativeById.get(michiBlock.id) : undefined;
      if (native) onAsk?.(native, question);
    },
    askAssistant: onAskAssistant ? (michiBlock) => {
      const native = michiBlock.id ? nativeById.get(michiBlock.id) : undefined;
      if (native) onAskAssistant(native);
    } : undefined,
    branch: () => {},
    apply,
    notice: () => {},
    copy: (blocks) => { void clipboard(blocks.map((block) => nativeText(typeof block.id === 'string' ? nativeById.get(block.id) : undefined)).filter(Boolean).join('\n\n')); },
    copyText: (text) => { void clipboard(text); },
    copyLink: () => {},
    sources: (display) => {
      const block = nativeById.get(display.id ?? '');
      return nativeSourceRows(block ? [...pageSegmentSources(block), ...(block.sources ?? [])] : [], sourceLabel, onOpenSource, () => setActionError('Source unavailable'));
    },
    openThread: () => {},
    moving: () => drag.moving || actionBusy,
    move: (id, step) => {
      const ordered = page.blocks.map((block) => block.id);
      const index = ordered.indexOf(id);
      const target = index + step;
      if (index < 0 || target < 0 || target >= ordered.length) return;
      const rest = ordered.filter((candidate) => candidate !== id);
      const after = target === 0 ? null : rest[target - 1];
      const expectRev = nativeById.get(id)?.rev;
      if (expectRev !== undefined) void perform([{ op: 'move', id, after, expectRev }]);
    },
    select,
    marginDown: () => {},
    marginEnter: () => {},
    dragStart: drag.dragStart,
    takeDragged: drag.takeDragged,
    orphan: (draft) => onOrphanDraft?.(draft),
    findBlock: () => null,
    addEntries,
    menuEntries: (display, actions) => {
      const block = nativeById.get(display.id ?? '');
      if (!block) return [];
      const pending = actionBusy || drag.moving;
      return [
        { id: 'select', label: activeSelection.includes(block.id) ? 'Deselect' : 'Select', glyph: <SquareCheck size={15} />, onSelect: () => select(block.id, 'toggle') },
        { id: 'ask', label: 'Ask', glyph: <Sparkles size={15} />, disabled: !onAsk && !onAskAssistant, onSelect: actions.ask },
        { id: 'sources', label: 'Sources', glyph: <Quote size={15} />, disabled: !onOpenSource || !(block.sources?.length || pageSegmentSources(block).length), onSelect: actions.sources },
        { id: 'ignore', label: 'Ignore', glyph: <EyeOff size={15} />, disabled: pending || !!block.edit, title: block.edit ? 'Automatic updates stopped' : 'Keep content and stop automatic updates', onSelect: () => {
          const { id, rev, sources: _sources, edit: _edit, ...content } = block;
          void perform([{ op: 'update', id, block: content, expectRev: rev }]);
        } },
        { id: 'archive', label: 'Archive', glyph: <Archive size={15} />, disabled: pending, title: 'Remove from this page and keep its history', onSelect: () => { void perform([{ op: 'delete', id: block.id, expectRev: block.rev }]); } },
        { divider: true, id: 'clipboard' },
        { id: 'copy', label: 'Copy text', glyph: <Copy size={15} />, onSelect: () => { void clipboard(nativeText(block)); } },
      ];
    },
  }), [activeSelection, actionBusy, addEntries, apply, compact, detailView, drag.dragStart, drag.takeDragged, drag.moving, nativeById, onAsk, onAskAssistant, onOpenSource, onOrphanDraft, onSelectBlock, onSelectionChange, page, perform, select, selectedBlockIds, sourceLabel]);

  const ctx = useMemo<MichiBlockCtx>(() => ({
    depth: 0,
    ...(!readOnly && targeting?.respondToBlock ? { requestAssistant: (display: MichiPageBlock, prompt: string, title: string, send: boolean) => {
      const native = nativeById.get(display.id ?? '');
      return !!native && !!targeting.respondToBlock?.({ backendConnectionId: backendConnectionIdForWorkspace(page.workspaceId), workspaceId: page.workspaceId, pageId: page.id, blockId: native.id, title, content: pageBlockText(native) }, prompt, send);
    } } : {}),
    renderNativePageLink: (displayBlock) => {
      const id = typeof displayBlock.pageId === 'string' ? displayBlock.pageId : '';
      const target = page.blocks.find((block) => block.type === 'page-link' && block.pageId === id);
      const label = target?.type === 'page-link' ? (id === page.id ? 'This page' : id) : id;
      return <button type="button" className="michi-doc-link-btn" onClick={() => onOpenPage(id)} disabled={!id}>{label || 'Open page'}</button>;
    },
    renderNativeDatabaseRef: (displayBlock) => {
      const block = page.blocks.find((candidate) => candidate.id === displayBlock.id);
      return block?.type === 'database-ref' ? renderDatabaseRef(block, compact, readOnly) : <p role="status">This database reference is unavailable.</p>;
    },
    renderNativeThreads: (displayBlock) => {
      const block = page.blocks.find((candidate) => candidate.id === displayBlock.id);
      return block?.type === 'threads' && renderThreads ? renderThreads(block) : <p className="michi-doc-unknown" role="status">These conversations are unavailable here.</p>;
    },
    renderNativeTaskView: (displayBlock) => (renderTaskView ? renderTaskView({
      ...(typeof displayBlock.viewId === 'string' ? { viewId: displayBlock.viewId } : {}),
      ...(typeof displayBlock.title === 'string' ? { title: displayBlock.title } : {}),
    }, compact, readOnly) : <p className="michi-doc-unknown" role="status">The task board is unavailable here.</p>),
    loadImages: true,
    ...(onOpenConversation ? { openConversation: onOpenConversation } : {}),
    ...(readOnly ? {} : { updateBlock, toggleItem }),
    ...(readOnly || !slotAddEntries ? {} : { slotAddEntries }),
    ...(onStartConversation && !readOnly ? { startConversation: (text: string) => onStartConversation(text, page.workspaceId) } : {}),
  }), [compact, onOpenConversation, onOpenPage, onStartConversation, page, readOnly, renderDatabaseRef, renderThreads, renderTaskView, slotAddEntries, toggleItem, updateBlock, nativeById, targeting]);

  const renderBlock = useCallback((displayBlock: MichiPageBlock, blockCtx: MichiBlockCtx) => {
    const native = displayBlock.id ? nativeById.get(displayBlock.id) : undefined;
    if (native?.type === 'home-section') return <><NativeHomeSection section={native.section} pageId={page.id} connectionId={backendConnectionIdForWorkspace(page.workspaceId)} readOnly={readOnly} />{native.interaction && <div className="page-view-block-entry"><PageViewEntry action={native.interaction.action}>{native.interaction.label}</PageViewEntry></div>}</>;
    if (native?.type === 'component' && renderComponent) return <>{renderComponent(native)}{native.interaction && <div className="page-view-block-entry"><PageViewEntry action={native.interaction.action}>{native.interaction.label}</PageViewEntry></div>}</>;
    return <MichiBlock block={displayBlock} ctx={blockCtx} />;
  }, [nativeById, renderComponent, page.id, page.workspaceId, readOnly]);

  const frameFor = useCallback((block: PageBlock, index: number) => {
    const display = michiBlocks[index];
    return <BlockFrame
      key={block.id}
      id={`page-block-${detailView ? `${instanceId}-` : ''}${block.id}`}
      block={display}
      ctx={{ ...ctx,
        renderNativeMarkdown: (markdown) => <NativeMarkdownSegments blockId={typeof markdown.id === 'string' ? markdown.id : undefined} text={typeof markdown.text === 'string' ? markdown.text : ''} segmentSources={markdown.segmentSources}
          sourceLabel={sourceLabel} onOpenSource={onOpenSource} onError={() => setActionError('Source unavailable')} loadImages />,
        ...(ctx.requestAssistant ? { requestAssistant: (_block, prompt, title, send) => ctx.requestAssistant!(display, prompt, title, send) } : {}) }}
      chrome={readOnly ? null : chrome}
      index={compact || detailView ? undefined : index}
      count={michiBlocks.length}
      selected={activeSelection.includes(block.id)}
      dragging={drag.dragging === block.id}
      renderBlock={renderBlock}
      renderDecorations={() => <>{renderDecorations?.(block)}{decisionNote?.blockId === block.id && <p className="native-page-decision-note" role="alert">{decisionNote.text}</p>}<div data-page-view-outlet="" /></>}
    />;
  }, [chrome, compact, ctx, michiBlocks, readOnly, renderBlock, renderDecorations, activeSelection, decisionNote, drag.dragging, sourceLabel, onOpenSource, detailView, instanceId]);

  // The page title and chrome belong to the document shell around this list.
  return (
    <MichiMantine><PageBlocksContext.Provider value={visibleBlocks.filter(block => block.type !== 'view' && (detailView || block.visibility !== 'detail')).map(toMichiBlock) as unknown as PageBlockWithSources[]}>
    <div ref={documentRef} className="michi-doc-blocks" data-native-page="" data-native-page-id={page.id} data-native-workspace-id={page.workspaceId} data-dragging={drag.dragging || undefined} onClick={selectOnClick && !readOnly ? (event) => {
      const id = clickedBlockId(event);
      if (id) chrome.select(id, 'toggle');
    } : undefined} aria-label={`${page.title || 'Untitled page'} content`}>
      {visibleBlocks.map((block, index) => block.type === 'view' || (!detailView && block.visibility === 'detail') ? null : frameFor(block, index))}
      {drag.drop && createPortal(<div className="native-page-drop" aria-hidden="true" style={{ left: drag.drop.left, top: drag.drop.top, width: drag.drop.width }} />, document.body)}
      {(actionError || drag.error) && <p className="native-page-decision-note" role="alert">{actionError || drag.error}</p>}
      {!page.blocks.length && <EmptyPageEditor page={page} onEdit={onEdit} onOrphanDraft={onOrphanDraft} readOnly={readOnly} />}
    </div>
    </PageBlocksContext.Provider></MichiMantine>
  );
}

/** What a selected block is called in the assistant's "About" chip: its own title, else its first words, else its kind. */
function selectionTitle(block: PageBlock): string {
  const title = pageBlockTitle(block);
  if (title) return title;
  const first = pageBlockText(block).split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return first.length > 60 ? `${first.slice(0, 59)}…` : first || block.type;
}

const INTERACTIVE = 'a, button, input, textarea, select, label, summary, [contenteditable="true"], [role="button"], [role="menu"], [role="dialog"], [data-michi-interactive], .michi-doc-block__margin, .michi-doc-toolbar';

/** The top-level block a plain click landed on, unless it hit a control, an editor or ended a text selection. */
function clickedBlockId(event: React.MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target as HTMLElement;
  if (target.closest(INTERACTIVE)) return null;
  if (window.getSelection()?.toString()) return null;
  const frame = target.closest<HTMLElement>('.michi-doc-block[data-top]');
  if (!frame || frame.dataset.editing !== undefined || frame.dataset.removing !== undefined) return null;
  return frame.dataset.blockId ?? null;
}

function EmptyPageEditor({ page, onEdit, onOrphanDraft, readOnly = false }: Pick<NativePageDocumentProps, 'page' | 'onEdit' | 'onOrphanDraft' | 'readOnly'>) {
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const draftRef = useRef('');
  const savingRef = useRef(false);
  const openedRevisionRef = useRef(page.revision);
  const changed = conflict || openedRevisionRef.current !== page.revision;
  const save = async (text: string, reapply = false) => {
    if (!text.trim() || savingRef.current || readOnly || (changed && !reapply)) return;
    savingRef.current = true;
    setBusy(true);
    try {
      const result = await onEdit([{ op: 'insert', block: { type: 'markdown', text }, after: null }], page.revision);
      if (result === 'ok') { draftRef.current = ''; setConflict(false); openedRevisionRef.current = page.revision; }
      else if (result === 'stale') setConflict(true);
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };
  useEffect(() => () => {
    const draft = draftRef.current;
    if (draft.trim()) onOrphanDraft?.({ label: 'New text', markdown: draft, text: draft });
  }, [onOrphanDraft]);
  if (readOnly) return <p className="michi-doc-unknown" role="status">This page is read only.</p>;
  return <div className="michi-doc-block__insert" data-empty-page-editor="">
    <TextBlockEditor
      label="New page content"
      initial=""
      placeholder="Write something; Markdown works"
      busy={busy}
      saveLabel="Add text"
      onChange={(text) => { draftRef.current = text; }}
      saveDisabled={readOnly || changed}
      notice={changed ? <PageChangedNote busy={busy} onReapply={() => { void save(draftRef.current, true); }} onCopy={() => { void clipboard(draftRef.current); }} /> : null}
      onSave={(text) => { void save(text); }}
      onCancel={() => { draftRef.current = ''; setConflict(false); }}
    />
  </div>;
}

export default NativePageDocument;
