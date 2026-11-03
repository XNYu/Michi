import React from 'react';
import type { PageBlock, PageChangeDto, PageDto, PageEditOp, SpaceSummaryDto, SpacesHomeSectionsDto, WorkspaceHomeSummaryDto } from 'michi-shared';
import { useChatNodesSnapshot } from '../../../../state/chatStore';
import { usePage, type UsePageResult } from '../../../../state/pages/usePage';
import { useSpaces } from '../../../../state/pages/useSpaces';
import { fetchPageActivitySeen } from '../../../../services/api/pages';
import type { ExactPageSource } from '../../../../state/pages/revealSource';
import NativeDatabase from '../NativeDatabase';
import { NativeTaskView } from '../NativeTaskView';
import { LiveThreadCards } from '../NativeThreadCards';
import { PageChangeTargets } from '../PageChangeTargets';
import { openNativePageRoute } from '../SpacesPage';
import { requestWorkspaceHome } from '../../../../state/pages/workspaceHomeNav';
import { blockFullText, blockLabel } from '../../content/page/michiPageModel';
import { toMichiBlock } from '../nativeBlockAdapter';
import { useMetaChatDocked } from '../metaChat/MetaChatArea';
import { blockItemTarget, NativePageDocument, openNewChatSheet, useMetaChatTargeting, useSpacesSourceNav, type MetaChatBlockTarget } from './homeLinks';
import { homeChangesShown } from './homeFormat';
import { homeWorkspaceCounts, useSpacesHomeSections } from './homeCounts';
import { prefersReducedMotion } from '../../../../hooks/useReducedMotion';
import { EASE } from '../../../../motion/tokens';
import { FRESH_MS } from '../../../../motion/useFresh';
// The targeted block's outline and the click cursor are the Space page's (`.space-doc`).
import '../spaces.css';

const startConversation = (text: string, workspaceId: string) => { openNewChatSheet({ text, workspaceId }); };
const NO_BLOCK_IDS: readonly string[] = [];

/** How the chat window names a home block it targets, and the text it sends along. */
export function homeBlockTarget(block: PageBlock): { title: string; content: string } {
  const content = toMichiBlock(block);
  return { title: blockLabel(content), content: blockFullText(content) };
}

export type WorkspaceDotTone = 'pending' | 'waiting' | 'stalled' | 'calm';

/** A workspace's dot as its Spaces sidebar row draws it: not written yet, waiting on you, stalled, or calm. */
export function workspaceDotTone(home: WorkspaceHomeSummaryDto, sections: SpacesHomeSectionsDto | null | undefined, spaces: readonly SpaceSummaryDto[] | null): WorkspaceDotTone {
  if (home.firstRun && home.firstRun.state !== 'done') return 'pending';
  const counts = homeWorkspaceCounts(sections, home.workspaceId);
  const waiting = counts.waiting > 0 || (home.pendingProposals ?? 0) > 0
    || (spaces ?? []).some((space) => space.workspaceId === home.workspaceId && space.pendingProposals > 0);
  return waiting ? 'waiting' : counts.stalled > 0 ? 'stalled' : 'calm';
}

const hasTable = (block: PageBlock) => block.type === 'markdown' && /^\s*\|/m.test(block.text);

/**
 * Marks each table row whose first cell names a workspace with that workspace's
 * dot tone (`data-home-tone`); the row's first cell draws the dot. The table is
 * Markdown drawn by MarkdownContent, so the mark is an attribute on its row.
 */
function WorkspaceRowDots({ container, homes, backendConnectionId }: {
  container: React.RefObject<HTMLDivElement | null>;
  homes: readonly WorkspaceHomeSummaryDto[];
  backendConnectionId: string;
}) {
  const sections = useSpacesHomeSections(backendConnectionId).data;
  const { spaces } = useSpaces(backendConnectionId);
  const tones = React.useMemo(() => new Map(homes.map((home) => [home.workspaceName.trim().toLowerCase(), workspaceDotTone(home, sections, spaces)] as const)), [homes, sections, spaces]);
  React.useLayoutEffect(() => {
    for (const row of Array.from(container.current?.querySelectorAll<HTMLTableRowElement>('tbody tr') ?? [])) {
      const tone = tones.get(row.cells[0]?.textContent?.trim().toLowerCase() ?? '');
      if (tone) row.setAttribute('data-home-tone', tone);
      else row.removeAttribute('data-home-tone');
    }
  });
  return null;
}

const BLOCK_ID_PREFIX = 'page-block-';
const REVEAL_MS = 200;
const REVEAL_STAGGER_MS = 40;
/** Past this many blocks the rest rise together, so a long home is not still arriving a second later. */
const REVEAL_STAGGER_CAP = 6;

/**
 * Which of a home's blocks are new arrivals: blocks the Meta agent writes
 * while the home is on screen. The blocks a page opens with (and any that
 * come in while its own copy loads and settles), and the ones the person adds
 * themselves, are simply there.
 */
export function blockRevealTracker(quietMs = FRESH_MS, graceMs = 600) {
  let state: { pageId: string; seen: Set<string>; quietUntil: number | null } | null = null;
  let editing = 0;
  let ownUntil = 0;
  return {
    /**
     * The ids among `ids` to reveal. The first look at a page (or at another
     * page) only learns its blocks. The quiet window starts at the first look
     * while the page's own copy is `live` (loaded, ready, not stale); nothing
     * is revealed before it ends, nor while the person's own edit is in flight
     * or just after.
     */
    claim(page: Pick<PageDto, 'id' | 'blocks'>, ids: readonly string[], live: boolean, now = Date.now()): string[] {
      if (!state || state.pageId !== page.id) {
        state = { pageId: page.id, seen: new Set(page.blocks.map((block) => block.id)), quietUntil: live ? now + quietMs : null };
        return [];
      }
      const seen = state.seen;
      const fresh = ids.filter((id) => !seen.has(id));
      for (const id of fresh) seen.add(id);
      if (!live) return [];
      if (state.quietUntil === null) {
        state.quietUntil = now + quietMs;
        return [];
      }
      return now < state.quietUntil || editing > 0 || now < ownUntil ? [] : fresh;
    },
    /** The person's own edit starts: blocks that appear until it ends, and a moment after, are theirs. Returns its end. */
    ownEdit() {
      editing += 1;
      let ended = false;
      return (now = Date.now()) => {
        if (ended) return;
        ended = true;
        editing -= 1;
        ownUntil = Math.max(ownUntil, now + graceMs);
      };
    },
  };
}

export type BlockReveal = {
  claim(ids: readonly string[]): string[];
  /** The place of the next revealed block in this commit, for the stagger. */
  next(): number;
};

/** Rises a block in place. Leaves no style behind: `fill: backwards` holds only the delay. */
function riseIn(el: HTMLElement, order: number) {
  if (typeof el.animate !== 'function') return;
  // Reduced motion keeps the fade and drops the rise, as motion's own components do.
  const still = prefersReducedMotion(document.documentElement.dataset.reduceMotion === 'on');
  el.animate(
    still ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
    { duration: REVEAL_MS, delay: Math.min(order, REVEAL_STAGGER_CAP) * REVEAL_STAGGER_MS, easing: `cubic-bezier(${EASE.out.join(',')})`, fill: 'backwards' },
  );
}

/** One segment of a home's blocks; a segment holding a table marks its workspace rows. */
function HomeSegment({ segment, homes, backendConnectionId, blockIds, reveal, children }: {
  segment: string;
  homes: readonly WorkspaceHomeSummaryDto[] | null;
  backendConnectionId: string;
  blockIds: readonly string[];
  reveal: BlockReveal;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  // After each commit, so the blocks are drawn but not yet painted. A block not drawn yet is still counted as seen:
  // it never rises in late.
  React.useLayoutEffect(() => {
    const root = ref.current;
    const fresh = root ? reveal.claim(blockIds) : [];
    if (!root || !fresh.length) return;
    const drawn = new Map(Array.from(root.querySelectorAll<HTMLElement>(`[id^="${BLOCK_ID_PREFIX}"]`)).map((el) => [el.id.slice(BLOCK_ID_PREFIX.length), el] as const));
    for (const id of fresh) {
      const el = drawn.get(id);
      if (el) riseIn(el, reveal.next());
    }
  });
  return <div ref={ref} className="spaces-home-blocks" data-segment={segment}>
    {children}
    {homes && homes.length > 0 && <WorkspaceRowDots container={ref} homes={homes} backendConnectionId={backendConnectionId} />}
  </div>;
}

export interface HomeDocument {
  page: PageDto | null;
  pageState: UsePageResult;
  readOnly: boolean;
  /** Renders some of the page's top-level blocks with the full page's editing, marks and changes. */
  renderBlocks(blocks: readonly PageBlock[], key: string): React.ReactNode;
}

/**
 * A home page read through the ordinary page hook, so its blocks edit, mark
 * and undo like any other page. `initial` is the page the home endpoint
 * returned; it is shown until the page hook has its own copy.
 */
export function useHomeDocument({ backendConnectionId, initial, allowEmptyEditor = true, workspaceHomes = null }: {
  backendConnectionId: string;
  initial: PageDto | null;
  /** Workspace homes by page id: a link to one opens that workspace's home in Spaces. */
  workspaceHomes?: readonly WorkspaceHomeSummaryDto[] | null;
  /** The empty-page editor appears in the last segment only. */
  allowEmptyEditor?: boolean;
}): HomeDocument {
  const workspaceId = initial?.workspaceId ?? '';
  const pageId = initial?.id ?? '';
  const pageState = usePage({ backendConnectionId, workspaceId, pageId, enabled: Boolean(pageId) });
  const page = pageState.page ?? initial;
  const changes: PageChangeDto[] = React.useMemo(() => pageState.changes ?? [], [pageState.changes]);
  const readOnly = !pageState.page || pageState.stale || pageState.status !== 'ready';
  const sourceNav = useSpacesSourceNav();
  const pageTitle = page?.title ?? '';
  const nodes = useChatNodesSnapshot();
  const identity = React.useMemo(() => ({ backendConnectionId, workspaceId }), [backendConnectionId, workspaceId]);

  // Marks and change lines show what changed since the person last left this home; until that
  // point is known only waiting suggestions show, so returning does not flash every old change.
  const [seenAt, setSeenAt] = React.useState<{ pageId: string; seq: number } | null>(null);
  React.useEffect(() => {
    if (!pageId) return undefined;
    let cancelled = false;
    void fetchPageActivitySeen(pageId, identity).then(
      (result) => { if (!cancelled) setSeenAt({ pageId, seq: result.lastSeenChangeSeq }); },
      () => { if (!cancelled) setSeenAt({ pageId, seq: Number.MAX_SAFE_INTEGER }); },
    );
    return () => { cancelled = true; };
  }, [identity, pageId]);
  const lastSeen = seenAt?.pageId === pageId ? Math.max(seenAt.seq, pageState.lastSeenChangeSeq) : Number.MAX_SAFE_INTEGER;
  const shownChanges = React.useMemo(() => homeChangesShown(changes, lastSeen), [changes, lastSeen]);
  const leaveRef = React.useRef({ acknowledge: pageState.acknowledgeThrough, latest: 0, seen: lastSeen });
  const latestChange = changes.reduce((max, change) => Math.max(max, change.seq), 0);
  // Passive effects run every cleanup before any new body, so the leave cleanup below still reads the page being left.
  React.useEffect(() => { leaveRef.current = { acknowledge: pageState.acknowledgeThrough, latest: latestChange, seen: lastSeen }; });
  React.useEffect(() => () => {
    const { acknowledge, latest, seen } = leaveRef.current;
    if (latest > seen && seen !== Number.MAX_SAFE_INTEGER) void acknowledge(latest).catch(() => {});
  }, [pageId]);

  const openSource = React.useCallback(
    (source: ExactPageSource) => sourceNav.openExactSourcePopover(identity, source, { page: { backendConnectionId, workspaceId, pageId, title: pageTitle } }),
    [backendConnectionId, identity, pageId, pageTitle, sourceNav, workspaceId],
  );
  // Only a conversation is named by its title; what a home run read is on the change record itself.
  const sourceLabel = React.useCallback((source: PageChangeDto['source']) => (
    source.kind === 'chat' || source.kind === 'helper' ? nodes[source.nodeId]?.title?.trim() || undefined : undefined
  ), [nodes]);
  const homesRef = React.useRef(workspaceHomes);
  homesRef.current = workspaceHomes;
  const openPage = React.useCallback((target: string) => {
    const home = homesRef.current?.find((candidate) => candidate.homePageId === target);
    if (home) requestWorkspaceHome({ workspaceId: home.workspaceId, backendConnectionId });
    else openNativePageRoute({ pageId: target, workspaceId, backendConnectionId });
  }, [backendConnectionId, workspaceId]);

  // Clicking a block targets it in the chat window, as on a Space page; the selection is the window's.
  const targeting = useMetaChatTargeting();
  const blocksRef = React.useRef<readonly PageBlock[]>([]);
  blocksRef.current = page?.blocks ?? [];
  const targetFor = React.useCallback((block: PageBlock): MetaChatBlockTarget => (
    { backendConnectionId, workspaceId, pageId, blockId: block.id, ...homeBlockTarget(block) }
  ), [backendConnectionId, pageId, workspaceId]);
  const selectBlock = React.useCallback((selection: { blockId: string } | null) => {
    const block = selection ? blocksRef.current.find((candidate) => candidate.id === selection.blockId) : undefined;
    targeting?.setTarget(block ? targetFor(block) : null);
  }, [targetFor, targeting]);
  const askAssistant = React.useCallback((block: PageBlock, item?: { index: number; text: string }) => (
    targeting?.askAbout(item ? blockItemTarget(targetFor(block), item) : targetFor(block))
  ), [targetFor, targeting]);
  const targetBlockId = targeting?.target?.pageId === pageId ? targeting.target.blockId : null;
  const selectedBlockIds = React.useMemo(() => (targetBlockId ? [targetBlockId] : NO_BLOCK_IDS), [targetBlockId]);
  const canTarget = Boolean(targeting) && !readOnly;
  const narrow = useMetaChatDocked();

  // Blocks the Meta agent writes while the home is on screen rise in; see blockRevealTracker.
  const [tracker] = React.useState(() => blockRevealTracker());
  const pageRef = React.useRef(page);
  pageRef.current = page;
  // The page's own copy, loaded and current: before it, what arrives is the page loading, not the Meta agent writing.
  const live = !readOnly;
  const liveRef = React.useRef(live);
  liveRef.current = live;
  const reveal = React.useMemo<BlockReveal>(() => {
    let batch: { n: number } | null = null;
    return {
      claim: (ids) => (pageRef.current ? tracker.claim(pageRef.current, ids, liveRef.current) : []),
      // Every segment's layout effect in one commit runs in one task: the count starts again after it.
      next: () => {
        if (!batch) {
          batch = { n: 0 };
          queueMicrotask(() => { batch = null; });
        }
        return batch.n++;
      },
    };
  }, [tracker]);
  // An empty home draws no segment; it still has to learn the page it opened with.
  React.useLayoutEffect(() => { reveal.claim([]); });

  const applyEdits = React.useCallback(async (ops: PageEditOp[], revision: number): Promise<'ok' | 'stale' | 'gone' | 'failed'> => {
    const current = pageState.page;
    if (!current || readOnly) return 'failed';
    if (current.revision !== revision) { pageState.refresh(); return 'stale'; }
    // The page draws the edit before it is saved: what appears meanwhile is the person's own.
    const ended = tracker.ownEdit();
    try {
      await pageState.edit(ops);
      return 'ok';
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 409) { pageState.refresh(); return 'stale'; }
      if (status === 404 || status === 410) return 'gone';
      return 'failed';
    } finally {
      ended();
    }
  }, [pageState, readOnly, tracker]);

  const renderBlocks = React.useCallback((blocks: readonly PageBlock[], key: string) => {
    if (!page) return null;
    if (!blocks.length && !(allowEmptyEditor && key === 'rest' && !page.blocks.length)) return null;
    const onChange = (action: (changeId: string) => Promise<unknown>) => (change: PageChangeDto) => { void action(change.id); };
    const decorations = (block: PageBlock) => <>
      <PageChangeTargets
        quiet
        changes={shownChanges}
        history={changes}
        target={{ kind: 'block', pageId: page.id, blockId: block.id }}
        sourceLabel={sourceLabel}
        onAccept={(change, edited) => { void pageState.accept(change.id, edited); }}
        onDismiss={onChange(pageState.dismiss)}
        onReopen={onChange(pageState.reopen)}
        onRevert={onChange(pageState.revert)}
        onRedo={onChange(pageState.redo)}
        onOpenSource={openSource}
        loading={readOnly}
        error={pageState.error}
      />
    </>;
    // Sources live in the block menu, without a footer below the content.
    return <HomeSegment key={key} segment={key} homes={workspaceHomes && blocks.some(hasTable) ? workspaceHomes : null} backendConnectionId={backendConnectionId}
      blockIds={blocks.map((block) => block.id)} reveal={reveal}><NativePageDocument
      page={page}
      visibleBlocks={blocks}
      onOpenSource={(source) => openSource({ kind: 'chat', ...source })}
      sourceLabel={(source) => sourceLabel({ kind: 'chat', ...source })}
      onEdit={applyEdits}
      onOpenPage={openPage}
      onStartConversation={startConversation}
      renderThreads={(block) => <LiveThreadCards block={block} connectionId={backendConnectionId} workspaceId={workspaceId} onOpen={(card) => {
        void sourceNav.openConversationFromSpaces({ backendConnectionId, workspaceId: card.workspaceId, nodeId: card.nodeId, messageId: card.messageId, focus: false });
      }} />}
      onOpenConversation={(nodeId) => { void sourceNav.openConversationFromSpaces({ backendConnectionId, workspaceId: null, nodeId, messageId: null, focus: false }); }}
      renderDatabaseRef={(block, compact, blockReadOnly) => <NativeDatabase
        databaseId={block.databaseId}
        workspaceId={workspaceId}
        connectionId={backendConnectionId}
        viewId={block.viewId}
        compact={compact || narrow}
        readOnly={blockReadOnly || readOnly}
        onNavigatePage={openPage}
        onOpenSource={openSource}
      />}
      renderTaskView={(block, compact, blockReadOnly) => <NativeTaskView workspaceId={workspaceId} connectionId={backendConnectionId}
        viewId={block.viewId} title={block.title} compact={compact || narrow} readOnly={blockReadOnly || readOnly}
        onNavigatePage={openPage} onOpenSource={openSource}
        onOpenThread={(card) => { void sourceNav.openConversationFromSpaces({ backendConnectionId, workspaceId: card.workspaceId, nodeId: card.nodeId, messageId: card.messageId, focus: false }); }} />}
      renderDecorations={decorations}
      onAskAssistant={canTarget ? askAssistant : undefined}
      onSelectionChange={canTarget ? selectBlock : undefined}
      selectedBlockIds={selectedBlockIds}
      selectOnClick={canTarget}
      readOnly={readOnly}
    /></HomeSegment>;
  }, [allowEmptyEditor, applyEdits, askAssistant, backendConnectionId, canTarget, changes, narrow, openPage, openSource, page, pageState, readOnly, reveal, selectBlock, selectedBlockIds, shownChanges, sourceLabel, sourceNav, workspaceHomes, workspaceId]);

  return { page, pageState, readOnly, renderBlocks };
}

/** A dashed stand-in for blocks the Meta agent has not written yet. */
export function HomePlaceholder({ title, text = 'The Meta agent writes this after it has written each workspace home.' }: { title?: string; text?: string }) {
  return (
    <section className="spaces-home-placeholder" aria-label={title ?? 'Not written yet'}>
      {title && <h2 className="spaces-home-h2">{title}</h2>}
      <span className="spaces-home-placeholder__line" aria-hidden="true" />
      <span className="spaces-home-placeholder__line spaces-home-placeholder__line--short" aria-hidden="true" />
      <p className="spaces-home-muted">{text}</p>
    </section>
  );
}

/** Scrolls to a block once its page has rendered it, and flashes it once. */
export function revealPageBlock(blockId: string, timeoutMs = 8000): () => void {
  const started = Date.now();
  let timer: number | undefined;
  let clear: number | undefined;
  const attempt = () => {
    const element = document.getElementById(`page-block-${blockId}`);
    if (element) {
      element.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      element.setAttribute('data-home-flash', '');
      clear = window.setTimeout(() => element.removeAttribute('data-home-flash'), 1600);
      return;
    }
    if (Date.now() - started < timeoutMs) timer = window.setTimeout(attempt, 100);
  };
  attempt();
  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    if (clear !== undefined) window.clearTimeout(clear);
  };
}
