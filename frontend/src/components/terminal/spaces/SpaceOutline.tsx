import React, { useState } from 'react';
import { FileText, Home, MoreHorizontal, Plus, Table2 } from 'lucide-react';
import { pageBlockTitle, type PageBlock, type PageBlockType, type PageSummaryDto } from 'michi-shared';
import { MichiMenu } from '../content/page/MichiMenu';

export interface SpaceOutlineProps {
  pages: PageSummaryDto[];
  activePageId: string;
  rootId: string | null;
  blocks: readonly PageBlock[];
  readOnly: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?(): void;
  onOpen(pageId: string): void;
  onCreateChild(parentId: string): void;
  onRename(page: PageSummaryDto): void;
  onMove(page: PageSummaryDto): void;
  onTrash(page: PageSummaryDto): void;
}

const capStyle: React.CSSProperties = {
  padding: '0 16px 8px',
  color: 'var(--term-muted)',
  fontFamily: 'var(--message-code-font)',
  fontSize: 'var(--fs-2xs)',
  letterSpacing: 'var(--ls-caps-wide)',
  textTransform: 'uppercase',
};

/** The blocks "On this page" names besides headings: the ones drawn under a title of their own. Text is read, not outlined. */
const OUTLINED: ReadonlySet<PageBlockType> = new Set<PageBlockType>([
  'callout', 'checklist', 'next-steps', 'timeline', 'plan-actual', 'compare', 'conflict', 'table', 'criteria', 'chart', 'gallery', 'forgot', 'threads',
]);

/** The titles these blocks draw when they have none of their own. */
const DRAWN_TITLE: Partial<Record<PageBlockType, string>> = {
  'plan-actual': 'Plan vs actual', criteria: 'Success criteria', forgot: 'You may have forgotten', threads: 'Threads',
};

export interface PageOutlineEntry { id: string; text: string; depth: 1 | 2 }

/**
 * What "On this page" lists, in page order: each heading, and the titled
 * blocks (a chart, a comparison, the success criteria) under the heading
 * above them, or on their own before the first heading.
 */
export function pageOutline(blocks: readonly PageBlock[]): PageOutlineEntry[] {
  let underHeading = false;
  return blocks.flatMap((block): PageOutlineEntry[] => {
    if (block.visibility === 'detail') return [];
    if (block.type === 'heading') {
      const text = block.text.trim();
      if (!text) return [];
      underHeading = true;
      return [{ id: block.id, text, depth: 1 }];
    }
    if (!OUTLINED.has(block.type)) return [];
    const text = pageBlockTitle(block) || DRAWN_TITLE[block.type] || '';
    return text ? [{ id: block.id, text, depth: underHeading ? 2 : 1 }] : [];
  });
}

/** The card beside a Space page: its page tree, then the headings and titled blocks of the open page. */
export function SpaceOutline({ pages, activePageId, rootId, blocks, readOnly, loading, error, onRetry, onOpen, onCreateChild, onRename, onMove, onTrash }: SpaceOutlineProps) {
  const [menu, setMenu] = useState<{ page: PageSummaryDto; anchor: HTMLElement } | null>(null);
  const children = new Map<string | null, PageSummaryDto[]>();
  for (const page of pages) {
    const key = page.id === rootId ? null : page.parentId;
    const group = children.get(key) ?? [];
    group.push(page);
    children.set(key, group);
  }
  for (const group of children.values()) group.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  const outline = pageOutline(blocks);

  const row = (page: PageSummaryDto, depth: number): React.ReactNode => {
    const current = page.id === activePageId;
    const Glyph = depth === 0 ? Home : page.title && /list|checklist|清单|行程|database/i.test(page.title) ? Table2 : FileText;
    return (
      <React.Fragment key={page.id}>
        <div className="space-outline__row" data-current={current || undefined}>
          <button
            type="button"
            className={`branches-directory__item space-outline__item${current ? ' is-current' : ''}`}
            aria-current={current ? 'page' : undefined}
            title={page.title}
            style={{ paddingLeft: 14 + depth * 16 }}
            onClick={() => onOpen(page.id)}
          >
            <Glyph size={13} strokeWidth={1.6} aria-hidden="true" />
            <span>{depth === 0 ? 'Home' : page.title || 'Untitled page'}</span>
            {page.pendingProposals > 0 && <span className="space-outline__count" aria-label={`${page.pendingProposals} waiting for you`}>{page.pendingProposals}</span>}
          </button>
          {!readOnly && (
            <button
              type="button"
              className="space-outline__more"
              aria-label={`Actions for ${page.title}`}
              aria-haspopup="menu"
              onClick={(event) => setMenu({ page, anchor: event.currentTarget })}
            >
              <MoreHorizontal size={14} strokeWidth={1.6} />
            </button>
          )}
        </div>
        {(children.get(page.id) ?? []).map((child) => row(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <nav className="branches-directory space-outline" aria-label="Page outline">
      <div style={capStyle}>Pages</div>
      {loading && !pages.length && <div className="space-outline__note" role="status">Loading pages…</div>}
      {error && !pages.length && (
        <div className="space-outline__note" role="alert">{error} {onRetry && <button type="button" className="michi-doc-link-btn" onClick={onRetry}>Retry</button>}</div>
      )}
      {(children.get(null) ?? []).map((page) => row(page, 0))}
      {!readOnly && rootId && (
        <button type="button" className="branches-directory__item space-outline__item space-outline__add" style={{ paddingLeft: 30 }} onClick={() => onCreateChild(activePageId)}>
          <Plus size={13} strokeWidth={1.6} aria-hidden="true" />
          <span>New page</span>
        </button>
      )}
      {outline.length > 0 && (
        <>
          <hr className="space-outline__rule" />
          <div style={capStyle}>On this page</div>
          {outline.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="branches-directory__item space-outline__section"
              data-depth={entry.depth}
              title={entry.text}
              style={{ padding: `6px 14px 6px ${entry.depth === 2 ? 30 : 14}px` }}
              onClick={() => document.getElementById(`page-block-${entry.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <span className="space-outline__section-text">{entry.text}</span>
            </button>
          ))}
        </>
      )}
      {menu && (
        <MichiMenu
          anchor={menu.anchor}
          label={`Actions for ${menu.page.title}`}
          width={200}
          entries={[
            { id: 'child', label: 'Add a page inside', onSelect: () => onCreateChild(menu.page.id) },
            { id: 'rename', label: 'Rename', onSelect: () => onRename(menu.page) },
            ...(menu.page.id !== rootId ? [{ id: 'move', label: 'Move…', onSelect: () => onMove(menu.page) }] : []),
            { divider: true, id: 'd' },
            { id: 'trash', label: menu.page.id === rootId ? 'Move page to trash' : 'Move to trash', danger: true, onSelect: () => onTrash(menu.page) },
          ]}
          onClose={(restore) => { const anchor = menu.anchor; setMenu(null); if (restore) anchor.focus({ preventScroll: true }); }}
        />
      )}
    </nav>
  );
}

export default SpaceOutline;
