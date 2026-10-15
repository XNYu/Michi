import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import MarkdownContent from '../../MarkdownContent';
import {
  activeTreeRootNodeId,
  chatLabel,
  useChatActions,
  useChatProjects,
  useStructuralSelector,
} from '../../../state/chatStore';
import { assistantAnswerVisibleText } from '../../../state/assistantBlocks';
import type { ChatNodeState } from '../../../state/chatTypes';
import type { BranchOverviewEntry } from 'michi-shared';
import { buildTree, type TreeNode } from '../../../state/tree';
import type { PageId } from '../../../state/commands';
import { useReducedMotion } from '../../../hooks/useReducedMotion';
import { revealInScroller, useScrollSpy } from '../../../hooks/useScrollSpy';
import { usePrefs } from '../../../state/prefs';

const OVERVIEW_MAX_CHARS = 720;
/** Keeps the current outline item clear of the card's top and bottom edges. */
const OUTLINE_REVEAL_PADDING = 24;

const branchAnchorId = (nodeId: string) => `branch-${nodeId}`;
const branchAnchorElement = (nodeId: string) => document.getElementById(branchAnchorId(nodeId));
const PROSE_CLASS =
  'prose prose-sm max-w-none wrap-break-word [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ' +
  '[&_p]:text-(--term-mid) [&_li]:text-(--term-mid) [&_strong]:text-(--term-fg) ' +
  '[&_a]:text-(--term-accent) [&_code]:text-(--term-fg)';

export interface BranchDocumentRow {
  nodeId: string;
  depth: number;
  title: string;
  overview: string | null;
  entries: BranchOverviewEntry[];
  generated: boolean;
  streaming: boolean;
}

export interface BranchDirectoryRow extends BranchDocumentRow {
  parentNodeId?: string;
  hasChildren: boolean;
}

const BRANCHES_LAYOUT_CSS = `
  .branches-layout {
    width: min(1160px, calc(100% - 48px));
    margin: 0 auto;
    /* Top pad clears the floating Graph/Timeline/Doc switcher (top:8, ~30px). */
    padding: 52px 0 64px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 236px;
    column-gap: 32px;
    align-items: start;
  }
  /* The document is a paper sheet floating on the soft field. */
  .branches-document {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
    background: var(--term-surface);
    border: 1px solid color-mix(in srgb, var(--term-fg) 7%, transparent);
    box-shadow: 0 2px 6px color-mix(in srgb, var(--term-fg) 4%, transparent),
      0 20px 50px -30px color-mix(in srgb, var(--term-fg) 25%, transparent);
    padding: 48px 56px 64px;
  }
  /* The outline is a sticky glass card beside the sheet. */
  .branches-directory {
    grid-column: 2;
    grid-row: 1;
    position: sticky;
    /* Pin below the floating switcher so a scrolled outline never slides under it. */
    top: 48px;
    align-self: start;
    /* The shell's topbar makes the actual scroller shorter than the window.
       Reserve the initial 52px inset as well as the sticky 48px inset. */
    max-height: calc(var(--branches-viewport-height, 100dvh) - 52px);
    overflow-y: auto;
    /* Wheeling past the outline's end must not scroll the document: that
       would move the current section and yank the outline back to it. */
    overscroll-behavior: contain;
    background: color-mix(in srgb, var(--term-surface) 82%, transparent);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    border: 1px solid color-mix(in srgb, var(--term-fg) 8%, transparent);
    box-shadow: 0 12px 36px -18px color-mix(in srgb, var(--term-fg) 30%, transparent);
    padding: 16px 0 10px;
  }
  .branches-directory__item {
    width: 100%;
    display: block;
    border: 0;
    border-left: 2px solid transparent;
    background: transparent;
    color: var(--term-mid);
    font-family: var(--ui-font);
    font-size: var(--fs-md);
    line-height: 1.5;
    text-align: left;
    overflow-wrap: anywhere;
    white-space: normal;
    cursor: pointer;
    transition: color var(--t-quick), background var(--t-quick), border-color var(--t-quick);
  }
  .branches-directory__item:hover { color: var(--term-fg); background: color-mix(in srgb, var(--term-accent-f) 30%, var(--term-surface)); }
  .branches-directory__item:focus-visible { outline: 1px solid var(--term-accent); outline-offset: -1px; }
  .branches-directory__item.is-current { color: var(--term-fg); border-left-color: var(--term-accent); background: color-mix(in srgb, var(--term-accent-f) 30%, var(--term-surface)); font-weight: 600; }
  @media (max-width: 860px) {
    .branches-layout { width: min(760px, calc(100% - 36px)); display: block; }
    .branches-directory { position: static; max-height: none; overflow: visible; margin-top: 20px; }
    .branches-document { padding: 32px 28px 48px; }
  }
`;

function trimOverview(text: string, maxChars = OVERVIEW_MAX_CHARS): string {
  const compact = text.trim();
  if (compact.length <= maxChars) return compact;
  const slice = compact.slice(0, maxChars);
  const boundary = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('。'), slice.lastIndexOf('\n'));
  const clipped = boundary > maxChars * 0.55 ? slice.slice(0, boundary + 1) : slice;
  return `${clipped.trimEnd()}…`;
}

/**
 * Old nodes predate branchOverview metadata. Use the first useful paragraph
 * of their latest answer so the document is informative immediately, without
 * pretending that excerpt is an agent-authored overview.
 */
export function fallbackBranchOverview(node: ChatNodeState): string | null {
  const assistant = [...node.messages].reverse().find((message) => message.role === 'assistant');
  if (assistant) {
    const visible = assistantAnswerVisibleText(assistant).trim();
    const paragraphs = visible.split(/\n\s*\n/);
    for (const paragraph of paragraphs) {
      const withoutHeading = paragraph
        .replace(/^#{1,6}\s+[^\n]+\n+/, '')
        .replace(/^#{1,6}\s+[^\n]+$/, '')
        .trim();
      if (withoutHeading) return trimOverview(withoutHeading);
    }
  }

  const firstUser = node.messages.find((message) => message.role === 'user');
  if (!firstUser) return null;
  const prompt = firstUser.text
    .replace(/^>.*$/gm, '')
    .replace(/^\/(?:btw|branch)\s+/i, '')
    .trim();
  return prompt ? trimOverview(prompt, 420) : null;
}

function flattenTree(root: TreeNode): TreeNode[] {
  return [root, ...root.children.flatMap(flattenTree)];
}

export function buildBranchDocumentRows(
  rootId: string,
  edges: Parameters<typeof buildTree>[1],
  nodes: Record<string, ChatNodeState>,
): BranchDocumentRow[] {
  const tree = buildTree(rootId, edges, (id) => !!nodes[id] && !nodes[id].deletedAt);
  return flattenTree(tree).flatMap((item) => {
    const node = nodes[item.nodeId];
    if (!node || node.kind === 'digest') return [];
    const entries = node.branchOverviewEntries ?? [];
    const generated = entries.length > 0;
    return [{
      nodeId: item.nodeId,
      depth: item.depth,
      title: node.title?.trim() || chatLabel(node),
      overview: generated
        ? entries.map((e) => e.text).join('\n\n')
        : fallbackBranchOverview(node),
      entries,
      generated,
      streaming: node.status === 'streaming',
    }];
  });
}

/**
 * The directory deliberately derives from the document rows, not a second
 * tree walk. That keeps its depth, filters, and ordering exactly in lockstep
 * with the Markdown-style document beside it.
 */
export function buildBranchDirectoryRows(rows: readonly BranchDocumentRow[]): BranchDirectoryRow[] {
  const ancestors: string[] = [];
  return rows.map((row, index) => {
    ancestors.length = row.depth;
    const parentNodeId = row.depth > 0 ? ancestors[row.depth - 1] : undefined;
    ancestors[row.depth] = row.nodeId;
    return {
      ...row,
      ...(parentNodeId ? { parentNodeId } : {}),
      hasChildren: (rows[index + 1]?.depth ?? -1) > row.depth,
    };
  });
}

export default function Branches({ onNav }: { onNav?: (page: PageId) => void } = {}) {
  const { activeProject } = useChatProjects();
  const { openPane } = useChatActions();
  const { prefs } = usePrefs();
  const rootId = activeTreeRootNodeId(activeProject);
  const activeTree = activeProject?.trees.find((tree) => tree.id === activeProject.activeTreeId) ?? null;

  const selectRows = useCallback(
    (nodes: Record<string, ChatNodeState>) =>
      rootId && activeProject ? buildBranchDocumentRows(rootId, activeProject.edges, nodes) : [],
    [activeProject, rootId],
  );
  const rows = useStructuralSelector(selectRows, rowsEqual);
  const directoryRows = useMemo(() => buildBranchDirectoryRows(rows), [rows]);
  const directoryNodeIds = useMemo(() => directoryRows.map((row) => row.nodeId), [directoryRows]);
  const reduceMotion = useReducedMotion(prefs.reduceMotion);
  // State, not a ref: the scroller mounts only after a thread is available,
  // and the spy must re-subscribe when it does.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!scroller) return;
    const measure = () => {
      scroller.style.setProperty('--branches-viewport-height', `${scroller.clientHeight}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);
  const { activeId: currentDirectoryNodeId, pin: pinDirectoryNode } =
    useScrollSpy(scroller, directoryNodeIds, branchAnchorElement);

  const threadTitle = useMemo(() => {
    const root = rows[0];
    return activeTree?.name?.trim() || root?.title || 'Untitled thread';
  }, [activeTree?.name, rows]);

  const openBranch = useCallback((nodeId: string) => {
    openPane(nodeId);
    onNav?.('dashboard');
  }, [onNav, openPane]);

  const navigateDirectory = useCallback((nodeId: string) => {
    pinDirectoryNode(nodeId);
    branchAnchorElement(nodeId)?.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [pinDirectoryNode, reduceMotion]);

  if (!activeProject) {
    return <BranchesEmpty title="No workspace selected" body="Choose a workspace to read its active thread." />;
  }
  if (!rootId || !activeTree) {
    return <BranchesEmpty title="No active thread" body="Create or restore a thread to build its Branches document." />;
  }

  const root = rows[0];
  const children = rows.slice(1);

  return (
    <main
      ref={setScroller}
      aria-label="Branch overview"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        // Soft field so the paper sheet + glass outline read as raised.
        background: 'color-mix(in srgb, var(--term-bg) 60%, var(--term-surface))',
      }}
    >
      <style>{BRANCHES_LAYOUT_CSS}</style>
      <div className="branches-layout">
        <BranchDirectory
          rows={directoryRows}
          currentNodeId={currentDirectoryNodeId}
          onNavigate={navigateDirectory}
          smoothScroll={!reduceMotion}
        />
        <article className="branches-document">
        <header style={{ marginBottom: root?.overview ? 40 : 56 }}>
          <div
            style={{
              color: 'var(--term-accent)',
              fontSize: 'var(--fs-xs)',
              letterSpacing: 'var(--ls-caps-wide)',
              marginBottom: 12,
              fontFamily: 'var(--message-code-font)',
              textTransform: 'uppercase',
            }}
          >
            Branch Document
          </div>
          <BranchHeading
            id={root ? branchAnchorId(root.nodeId) : undefined}
            level={1}
            title={threadTitle}
            streaming={root?.streaming ?? false}
            onOpen={root ? () => openBranch(root.nodeId) : undefined}
          />
          <div
            style={{
              fontFamily: 'var(--message-code-font)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--term-muted)',
              marginTop: 4,
            }}
          >
            {rows.length} {rows.length === 1 ? 'branch' : 'branches'} · {activeProject.name}
          </div>
          {root?.overview && (
            <OverviewText text={root.overview} generated={root.generated} root />
          )}
        </header>

        {children.map((row) => (
          <BranchSection key={row.nodeId} row={row} onOpen={() => openBranch(row.nodeId)} />
        ))}

        {rows.length === 0 && (
          <p style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-lg)' }}>This thread has no readable branches yet.</p>
        )}
        </article>
      </div>
    </main>
  );
}

function BranchDirectory({
  rows,
  currentNodeId,
  onNavigate,
  smoothScroll,
}: {
  rows: readonly BranchDirectoryRow[];
  currentNodeId: string | null;
  onNavigate: (nodeId: string) => void;
  smoothScroll: boolean;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  // A long outline scrolls on its own; keep the reader's section in view.
  useEffect(() => {
    const nav = navRef.current;
    const item = currentNodeId ? itemRefs.current.get(currentNodeId) : undefined;
    if (!nav || !item) return;
    const reveal = () => revealInScroller(nav, item, {
      padding: OUTLINE_REVEAL_PADDING,
      behavior: smoothScroll ? 'smooth' : 'auto',
    });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [currentNodeId, smoothScroll]);

  return (
    <nav ref={navRef} className="branches-directory" aria-label="Branch directory">
      <div
        style={{
          padding: '0 16px 8px',
          color: 'var(--term-muted)',
          fontFamily: 'var(--message-code-font)',
          fontSize: 'var(--fs-2xs)',
          letterSpacing: 'var(--ls-caps-wide)',
          textTransform: 'uppercase',
        }}
      >
        Outline
      </div>
      <div role="tree" aria-label="Branch hierarchy">
        {rows.map((row) => {
          const current = row.nodeId === currentNodeId;
          return (
            <button
              key={row.nodeId}
              ref={(element) => {
                if (element) itemRefs.current.set(row.nodeId, element);
                else itemRefs.current.delete(row.nodeId);
              }}
              type="button"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-current={current ? 'location' : undefined}
              title={row.title}
              className={`branches-directory__item${current ? ' is-current' : ''}`}
              onClick={() => onNavigate(row.nodeId)}
              style={{
                padding: '6px 14px',
                paddingLeft: 14 + Math.min(row.depth, 5) * 12,
                fontWeight: current ? 600 : row.depth === 0 ? 600 : 420,
              }}
            >
              {row.title}
              {row.streaming && <span aria-label=" active" className="map-card__live-dot" style={{ color: 'var(--term-accent)' }}> ●</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function BranchSection({ row, onOpen }: { row: BranchDocumentRow; onOpen: () => void }) {
  const level = Math.min(row.depth + 1, 4) as 2 | 3 | 4;
  const deepIndent = row.depth > 3 ? Math.min((row.depth - 3) * 18, 54) : 0;
  return (
    <section
      id={branchAnchorId(row.nodeId)}
      aria-labelledby={`branch-title-${row.nodeId}`}
      style={{
        marginTop: row.depth === 1 ? 32 : row.depth === 2 ? 26 : 22,
        marginLeft: deepIndent,
      }}
    >
      <BranchHeading
        id={`branch-title-${row.nodeId}`}
        level={level}
        title={row.title}
        streaming={row.streaming}
        onOpen={onOpen}
      />
      {row.overview ? (
        <OverviewText text={row.overview} generated={row.generated} />
      ) : (
        <button
          type="button"
          onClick={onOpen}
          style={{
            border: 0,
            background: 'transparent',
            padding: '7px 0',
            color: 'var(--term-muted)',
            font: 'inherit',
            fontSize: 'var(--fs-lg)',
            cursor: 'pointer',
          }}
        >
          No overview yet · open branch →
        </button>
      )}
    </section>
  );
}

function BranchHeading({
  id,
  level,
  title,
  streaming,
  onOpen,
}: {
  id?: string;
  level: 1 | 2 | 3 | 4;
  title: string;
  streaming: boolean;
  onOpen?: () => void;
}) {
  const sizes = { 1: 26, 2: 16.5, 3: 15, 4: 14 } as const;
  const margins = { 1: 6, 2: 10, 3: 8, 4: 7 } as const;
  const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
      <Tag
        id={id}
        style={{
          margin: `0 0 ${margins[level]}px`,
          color: 'var(--term-fg)',
          fontFamily: 'var(--message-latin-font), var(--message-cjk-font)',
          fontSize: sizes[level],
          lineHeight: level === 1 ? 1.15 : 1.3,
          letterSpacing: 'var(--ls-tight)',
          fontWeight: 700,
          textWrap: 'balance',
          minWidth: 0,
        }}
      >
        {title}
      </Tag>
      {streaming && (
        <span
          aria-label="Branch is active"
          title="Branch is active"
          style={{ color: 'var(--term-accent)', fontSize: 'var(--fs-md)', animation: 'pulse var(--t-loop) ease-in-out infinite' }}
        >
          ●
        </span>
      )}
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${title}`}
          title="Open conversation"
          style={{
            border: 0,
            background: 'transparent',
            color: 'var(--term-faint)',
            padding: '2px 4px',
            cursor: 'pointer',
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-md)',
            flexShrink: 0,
          }}
        >
          ↗
        </button>
      )}
    </div>
  );
}

function OverviewText({ text, generated, root = false }: { text: string; generated: boolean; root?: boolean }) {
  return (
    <div
      title={generated ? 'Agent-maintained branch overview' : 'Preview from the latest conversation'}
      // The root summary reads as an inset panel on the sheet; per-branch
      // overviews flow as plain body copy.
      style={root ? {
        marginTop: 20,
        background: 'color-mix(in srgb, var(--term-bg) 60%, var(--term-surface))',
        border: '1px solid color-mix(in srgb, var(--term-fg) 5%, transparent)',
        padding: '14px 18px',
      } : undefined}
    >
      <MarkdownContent
        text={text}
        size={root ? 'base' : 'sm'}
        className={PROSE_CLASS}
        style={{
          color: 'var(--term-mid)',
          fontFamily: 'var(--message-latin-font), var(--message-cjk-font)',
          fontSize: root ? 'var(--fs-xl)' : 'var(--fs-lg)',
          lineHeight: root ? 1.75 : 1.68,
          maxWidth: '68ch',
        }}
      />
    </div>
  );
}

function BranchesEmpty({ title, body }: { title: string; body: string }) {
  return (
    <main
      style={{
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--term-pane-bg, var(--term-surface))',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <h1 style={{ margin: 0, color: 'var(--term-fg)', fontSize: 'var(--fs-4xl)', fontWeight: 600 }}>{title}</h1>
        <p style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-lg)', lineHeight: 1.6 }}>{body}</p>
      </div>
    </main>
  );
}

function rowsEqual(a: BranchDocumentRow[], b: BranchDocumentRow[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((row, index) => {
    const other = b[index];
    return row.nodeId === other.nodeId
      && row.depth === other.depth
      && row.title === other.title
      && row.overview === other.overview
      && row.entries === other.entries
      && row.generated === other.generated
      && row.streaming === other.streaming;
  });
}
