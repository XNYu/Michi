import React from 'react';
import type { PageChangeDto } from 'michi-shared';
import { ChangeCard, isPageChangeRedoable, isPageChangeRevertible, type AcceptedPageEdit } from './ChangeCard';
import type { ExactPageSource } from './SourceTrace';
import { buildPageChangeIndex, changeTargetKey } from './changeIndex';

export type PageChangeTargetFilter =
  | { kind: 'block'; pageId: string; blockId: string }
  | { kind: 'database'; databaseId: string };

export function pageChangesForTarget(changes: readonly PageChangeDto[], target: PageChangeTargetFilter): PageChangeDto[] {
  const matching = changes.filter((change) => target.kind === 'block'
    ? change.target.kind === 'block' && change.target.pageId === target.pageId && change.target.blockId === target.blockId
    : (change.target.kind === 'row' || change.target.kind === 'database') && change.target.databaseId === target.databaseId);
  const { byTarget } = buildPageChangeIndex(matching);
  const latest = [...byTarget.values()]
    .map((items) => items.reduce((latest, item) => item.seq > latest.seq ? item : latest))
    .filter((change) => change.source.kind !== 'user' && (change.proposalState !== null || isPageChangeRevertible(change) || isPageChangeRedoable(change)))
  const unresolved = matching.filter((change) => change.source.kind !== 'user' && (change.proposalState === 'pending' || change.proposalState === 'dismissed'));
  return [...new Map([...latest, ...unresolved].map((change) => [change.id, change])).values()].sort((left, right) => right.seq - left.seq);
}

/**
 * What a target shows after `change` was undone came from the change before
 * it: that change's source, or null when a person made it. Undefined when no
 * earlier change is loaded.
 */
export function sourceShownAfterUndo(change: PageChangeDto, history: readonly PageChangeDto[]): PageChangeDto['source'] | null | undefined {
  if (change.applicationState !== 'reverted') return undefined;
  const key = changeTargetKey(change);
  let before: PageChangeDto | undefined;
  for (const candidate of history) {
    if (candidate.seq >= change.seq || candidate.applicationState !== 'applied' || changeTargetKey(candidate) !== key) continue;
    if (!before || candidate.seq > before.seq) before = candidate;
  }
  if (!before) return undefined;
  return before.source.kind === 'user' ? null : before.source;
}

export interface PageChangeTargetsProps {
  changes: readonly PageChangeDto[];
  /** Every loaded change of the page, when `changes` shows only some: an undone line names what came before. */
  history?: readonly PageChangeDto[];
  target: PageChangeTargetFilter;
  onAccept: (change: PageChangeDto, edited?: AcceptedPageEdit) => void | Promise<void>;
  onDismiss: (change: PageChangeDto) => void | Promise<void>;
  onReopen: (change: PageChangeDto) => void | Promise<void>;
  onRevert: (change: PageChangeDto) => void | Promise<void>;
  onRedo: (change: PageChangeDto) => void | Promise<void>;
  onOpenSource: (source: ExactPageSource) => void | boolean | Promise<void | boolean>;
  loading: boolean;
  error: string | null;
  sourceLabel?: (source: PageChangeDto['source']) => string | undefined;
  /** Page blocks show pending suggestions only; their menu owns source navigation. */
  quiet?: boolean;
}

export function PageChangeTargets({ changes = [], history, target, onAccept, onDismiss, onReopen, onRevert, onRedo, onOpenSource, loading, error, sourceLabel, quiet = false }: PageChangeTargetsProps) {
  const relevant = pageChangesForTarget(changes, target).filter(change => !quiet || change.proposalState === 'pending');
  if (!relevant.length) return null;
  return (
    <div className="page-change-targets" aria-label={target.kind === 'block' ? 'Changes to this block' : 'Changes to this database'}>
      {relevant.map((change) => <ChangeCard key={change.id} variant="inline" quiet={quiet} sourceLabel={sourceLabel} shownSource={sourceShownAfterUndo(change, history ?? changes)} change={change} onAccept={onAccept} onDismiss={onDismiss} onReopen={onReopen} onRevert={onRevert} onRedo={onRedo} onOpenSource={onOpenSource} loading={loading} error={error} />)}
    </div>
  );
}
