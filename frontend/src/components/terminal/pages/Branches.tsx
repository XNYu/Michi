import React, { useCallback, useMemo, useState } from 'react';
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

const OVERVIEW_MAX_CHARS = 720;
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
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(248px, 292px);
    column-gap: 40px;
  }
  .branches-document {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
    padding: 62px 0 112px;
  }
  .branches-directory {
    grid-column: 2;
    grid-row: 1;
    position: sticky;
    top: 0;
    align-self: start;
    max-height: 100dvh;
    overflow-y: auto;
    padding: 72px 0 36px;
  }
  .branches-directory__item {
    width: 100%;
    display: block;
    border: 0;
    border-left: 2px solid transparent;
    background: transparent;
    color: var(--term-muted);
    font-family: var(--ui-font);
    font-size: 12px;
    line-height: 1.45;
    text-align: left;
    overflow-wrap: anywhere;
    white-space: normal;
    cursor: pointer;
    transition: color var(--t-quick), background var(--t-quick), border-color var(--t-quick);
  }
  .branches-directory__item:hover { color: var(--term-fg); background: var(--term-alt); }
  .branches-directory__item:focus-visible { outline: 1px solid var(--term-accent); outline-offset: -1px; }
  .branches-directory__item.is-current { color: var(--term-fg); border-left-color: var(--term-accent); background: var(--term-alt); }
  @media (max-width: 860px) {
    .branches-layout { width: min(760px, calc(100% - 36px)); display: block; }
    .branches-directory { position: static; max-height: none; overflow: visible; padding: 30px 0 0; }
    .branches-document { padding-top: 40px; }
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
  const rootId = activeTreeRootNodeId(activeProject);
  const activeTree = activeProject?.trees.find((tree) => tree.id === activeProject.activeTreeId) ?? null;

  const selectRows = useCallback(
    (nodes: Record<string, ChatNodeState>) =>
      rootId && activeProject ? buildBranchDocumentRows(rootId, activeProject.edges, nodes) : [],
    [activeProject, rootId],
  );
  const rows = useStructuralSelector(selectRows, rowsEqual);
  const directoryRows = useMemo(() => buildBranchDirectoryRows(rows), [rows]);
  const [selectedDirectoryNodeId, setSelectedDirectoryNodeId] = useState<string | null>(null);

  const threadTitle = useMemo(() => {
    const root = rows[0];
    return activeTree?.name?.trim() || root?.title || 'Untitled thread';
  }, [activeTree?.name, rows]);

  const openBranch = useCallback((nodeId: string) => {
    openPane(nodeId);
    onNav?.('dashboard');
  }, [onNav, openPane]);

  const currentDirectoryNodeId =
    selectedDirectoryNodeId && directoryRows.some((row) => row.nodeId === selectedDirectoryNodeId)
      ? selectedDirectoryNodeId
      : directoryRows[0]?.nodeId ?? null;

  const navigateDirectory = useCallback((nodeId: string) => {
    setSelectedDirectoryNodeId(nodeId);
    const section = document.getElementById(`branch-${nodeId}`);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section?.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, []);

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
      aria-label="Branch overview"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        background: 'var(--term-pane-bg, var(--term-surface))',
      }}
    >
      <style>{BRANCHES_LAYOUT_CSS}</style>
      <div className="branches-layout">
        <BranchDirectory
          rows={directoryRows}
          currentNodeId={currentDirectoryNodeId}
          onNavigate={navigateDirectory}
        />
        <article className="branches-document">
        <header style={{ marginBottom: root?.overview ? 52 : 68 }}>
          <div
            style={{
              color: 'var(--term-faint)',
              fontSize: 10.5,
              letterSpacing: '.12em',
              marginBottom: 13,
              fontFamily: 'var(--ui-font)',
            }}
          >
            {activeProject.name} / {rows.length} {rows.length === 1 ? 'branch' : 'branches'}
          </div>
          <BranchHeading
            id={root ? `branch-${root.nodeId}` : undefined}
            level={1}
            title={threadTitle}
            streaming={root?.streaming ?? false}
            onOpen={root ? () => openBranch(root.nodeId) : undefined}
          />
          {root?.overview && (
            <OverviewText text={root.overview} generated={root.generated} root />
          )}
        </header>

        {children.map((row) => (
          <BranchSection key={row.nodeId} row={row} onOpen={() => openBranch(row.nodeId)} />
        ))}

        {rows.length === 0 && (
          <p style={{ color: 'var(--term-muted)', fontSize: 13 }}>This thread has no readable branches yet.</p>
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
}: {
  rows: readonly BranchDirectoryRow[];
  currentNodeId: string | null;
  onNavigate: (nodeId: string) => void;
}) {
  return (
    <nav className="branches-directory" aria-label="Branch directory">
      <div
        style={{
          marginBottom: 10,
          color: 'var(--term-faint)',
          fontFamily: 'var(--ui-font)',
          fontSize: 10.5,
          letterSpacing: '.1em',
        }}
      >
        Directory
      </div>
      <div role="tree" aria-label="Branch hierarchy">
        {rows.map((row) => {
          const current = row.nodeId === currentNodeId;
          return (
            <button
              key={row.nodeId}
              type="button"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-current={current ? 'location' : undefined}
              title={row.title}
              className={`branches-directory__item${current ? ' is-current' : ''}`}
              onClick={() => onNavigate(row.nodeId)}
              style={{
                padding: '6px 7px 6px',
                paddingLeft: 8 + Math.min(row.depth, 5) * 14,
                fontWeight: row.depth === 0 ? 600 : row.hasChildren ? 520 : 420,
              }}
            >
              {row.title}
              {row.streaming && <span aria-label=" active" style={{ color: 'var(--term-accent)' }}> ·</span>}
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
      id={`branch-${row.nodeId}`}
      aria-labelledby={`branch-title-${row.nodeId}`}
      style={{
        marginTop: row.depth === 1 ? 54 : row.depth === 2 ? 42 : 34,
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
            color: 'var(--term-faint)',
            font: 'inherit',
            fontSize: 13,
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
  const sizes = { 1: 42, 2: 25, 3: 19, 4: 16 } as const;
  const margins = { 1: 22, 2: 13, 3: 10, 4: 9 } as const;
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
          lineHeight: level === 1 ? 1.08 : 1.2,
          letterSpacing: level <= 2 ? '-.025em' : '-.012em',
          fontWeight: level === 1 ? 560 : level === 2 ? 540 : 600,
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
          style={{ color: 'var(--term-accent)', fontSize: 12, animation: 'pulse 1.2s ease-in-out infinite' }}
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
            fontSize: 12,
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
    <div title={generated ? 'Agent-maintained branch overview' : 'Preview from the latest conversation'}>
      <MarkdownContent
        text={text}
        size={root ? 'base' : 'sm'}
        className={PROSE_CLASS}
        style={{
          color: 'var(--term-mid)',
          fontFamily: 'var(--message-latin-font), var(--message-cjk-font)',
          fontSize: root ? 16 : 15,
          lineHeight: root ? 1.72 : 1.68,
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
        <h1 style={{ margin: 0, color: 'var(--term-fg)', fontSize: 22, fontWeight: 600 }}>{title}</h1>
        <p style={{ color: 'var(--term-muted)', fontSize: 13, lineHeight: 1.6 }}>{body}</p>
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
