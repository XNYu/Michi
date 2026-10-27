import type { PageChangeDto } from 'michi-shared';

export interface PageChangeIndex {
  byTarget: ReadonlyMap<string, readonly PageChangeDto[]>;
  byBatch: ReadonlyMap<string, readonly PageChangeDto[]>;
}

export function changeTargetKey(change: PageChangeDto): string {
  switch (change.target.kind) {
    case 'block': return `block:${change.target.pageId}:${change.target.blockId}`;
    case 'row': return `row:${change.target.databaseId}:${change.target.rowId}`;
    case 'database': return `database:${change.target.databaseId}`;
  }
}

export function buildPageChangeIndex(changes: readonly PageChangeDto[]): PageChangeIndex {
  const byTarget = new Map<string, PageChangeDto[]>();
  const byBatch = new Map<string, PageChangeDto[]>();
  for (const change of changes) {
    const targetKey = changeTargetKey(change);
    const targetChanges = byTarget.get(targetKey) ?? [];
    targetChanges.push(change);
    byTarget.set(targetKey, targetChanges);
    const batchChanges = byBatch.get(change.batchId) ?? [];
    batchChanges.push(change);
    byBatch.set(change.batchId, batchChanges);
  }
  return { byTarget, byBatch };
}

/** Only the newest ledger entry can own the current target head. Hiding older
 * rows avoids offering Undo for an entry that a later user/agent write replaced. */
export function latestPageChangesForTarget(changes: readonly PageChangeDto[], target: { kind: 'block'; pageId: string; blockId: string } | { kind: 'row'; databaseId: string; rowId: string } | { kind: 'database'; databaseId: string }): PageChangeDto[] {
  const indexed = buildPageChangeIndex(changes);
  const key = target.kind === 'block' ? `block:${target.pageId}:${target.blockId}`
    : target.kind === 'row' ? `row:${target.databaseId}:${target.rowId}` : `database:${target.databaseId}`;
  const items = indexed.byTarget.get(key) ?? [];
  if (!items.length) return [];
  return [items.reduce((latest, item) => item.seq > latest.seq ? item : latest)];
}
