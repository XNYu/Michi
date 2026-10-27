import React from 'react';
import type { PageSummaryDto } from 'michi-shared';

export interface PageTreeProps {
  pages: PageSummaryDto[];
  activePageId: string;
  onOpen(pageId: string): void;
  onCreateChild(pageId: string): void;
  onRename(page: PageSummaryDto): void;
  onMove(page: PageSummaryDto): void;
  onTrash(page: PageSummaryDto): void;
  readOnly?: boolean;
}

export function PageTree({ pages, activePageId, onOpen, onCreateChild, onRename, onMove, onTrash, readOnly = false }: PageTreeProps) {
  const children = new Map<string | null, PageSummaryDto[]>();
  pages.forEach((page) => {
    const group = children.get(page.parentId) ?? [];
    group.push(page);
    children.set(page.parentId, group);
  });
  for (const group of children.values()) group.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));

  const renderBranch = (parentId: string | null, depth: number): React.ReactNode =>
    (children.get(parentId) ?? []).map((page) => (
      <React.Fragment key={page.id}>
        <div className="spaces-tree-row" style={{ '--spaces-tree-depth': depth } as React.CSSProperties}>
          <button type="button" className="spaces-tree-open" aria-current={activePageId === page.id ? 'page' : undefined} onClick={() => onOpen(page.id)}>
            <span className="spaces-tree-marker" aria-hidden="true">{depth ? '↳' : '▤'}</span>
            <span>{page.title || 'Untitled page'}</span>
          </button>
          <div className="spaces-tree-actions">
            <button type="button" disabled={readOnly} aria-label={`Add child page to ${page.title}`} title="Add child page" onClick={() => onCreateChild(page.id)}>＋</button>
            <button type="button" disabled={readOnly} aria-label={`Rename ${page.title}`} title="Rename" onClick={() => onRename(page)}>Rename</button>
            <button type="button" disabled={readOnly} aria-label={`Move ${page.title}`} title="Move" onClick={() => onMove(page)}>Move</button>
            <button type="button" disabled={readOnly} aria-label={`Move ${page.title} to trash`} title="Move to trash" onClick={() => onTrash(page)}>⌫</button>
          </div>
        </div>
        {renderBranch(page.id, depth + 1)}
      </React.Fragment>
    ));

  return <nav className="spaces-page-tree" aria-label="Page outline">{renderBranch(null, 0)}</nav>;
}

export default PageTree;
