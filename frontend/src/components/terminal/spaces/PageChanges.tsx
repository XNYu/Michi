import React, { useMemo } from 'react';
import type { PageChangeDto } from 'michi-shared';
import { ChangeCard, isPageChangeRevertible, type AcceptedPageEdit } from './ChangeCard';
import type { ExactPageSource } from './SourceTrace';
import './pageChanges.css';

export interface PageChangesProps {
  changes: readonly PageChangeDto[];
  onAccept: (change: PageChangeDto, edited?: AcceptedPageEdit) => void | Promise<void>;
  onDismiss: (change: PageChangeDto) => void | Promise<void>;
  onReopen: (change: PageChangeDto) => void | Promise<void>;
  onRevert: (change: PageChangeDto) => void | Promise<void>;
  onRedo: (change: PageChangeDto) => void | Promise<void>;
  onRevertBatch: (batchId: string) => void | Promise<void>;
  onOpenSource: (source: ExactPageSource) => void | boolean | Promise<void | boolean>;
  loading: boolean;
  error: string | null;
  hasMore?: boolean;
  onLoadMore?: () => void | Promise<void>;
}

export function PageChanges({ changes, onAccept, onDismiss, onReopen, onRevert, onRedo, onRevertBatch, onOpenSource, loading, error, hasMore = false, onLoadMore }: PageChangesProps) {
  const batches = useMemo(() => {
    const groups = new Map<string, PageChangeDto[]>();
    for (const change of changes) {
      const group = groups.get(change.batchId) ?? [];
      group.push(change);
      groups.set(change.batchId, group);
    }
    return [...groups].map(([batchId, items]) => ({ batchId, items, applied: items.filter(isPageChangeRevertible).length, waiting: items.filter((item) => item.proposalState === 'pending').length }));
  }, [changes]);

  if (loading && changes.length === 0) return <div className="page-changes-status" role="status">Loading page changes…</div>;
  if (error && changes.length === 0 && !hasMore) return <div className="page-changes-status page-changes-status--error" role="alert">{error}</div>;
  if (changes.length === 0 && !hasMore && !error) return null;
  const waiting = changes.filter((change) => change.proposalState === 'pending').length;
  const reversible = changes.filter(isPageChangeRevertible).length;

  return (
    <details className="page-changes page-changes-history">
      <summary>Activity · {changes.length} changes{waiting ? ` · ${waiting} waiting` : ''}{reversible ? ` · ${reversible} reversible` : ''}</summary>
      {error && <div className="page-changes-status page-changes-status--error" role="alert">{error}</div>}
      {batches.map(({ batchId, items, applied, waiting }) => (
        <section className="page-change-batch" key={batchId}>
          <header className="page-change-batch__header">
            <span>{applied > 0 ? `${applied} agent update${applied === 1 ? '' : 's'}` : items.some((item) => item.applicationState === 'applied' && item.source.kind === 'user') ? 'Your changes' : 'Suggested changes'}{waiting > 0 ? ` · ${waiting} waiting for you` : ''}</span>
            {applied > 0 && <button type="button" disabled={loading} onClick={() => void onRevertBatch(batchId)}>Undo all ({applied})</button>}
          </header>
          {items.map((change) => (
            <ChangeCard key={change.id} change={change} onAccept={onAccept} onDismiss={onDismiss} onReopen={onReopen} onRevert={onRevert} onRedo={onRedo} onOpenSource={onOpenSource} loading={loading} error={error} />
          ))}
        </section>
      ))}
      {hasMore && <button type="button" className="page-changes-load-more" disabled={loading} onClick={() => { void onLoadMore?.(); }}>Load older activity</button>}
    </details>
  );
}

export { buildPageChangeIndex } from './changeIndex';
export { ChangeCard } from './ChangeCard';
export { isPageChangeRevertible, isPageChangeRedoable } from './ChangeCard';
export type { AcceptedPageEdit, ChangeCardProps } from './ChangeCard';
export { latestPageChangesForTarget } from './changeIndex';
