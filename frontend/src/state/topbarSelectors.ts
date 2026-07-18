import type { PageId } from './commands';
import type { ChatNodeState } from './chatTypes';
import { isArchiveGroupId } from './trashActions';

export function selectTrashGroupCountForPage(
  page: PageId,
  nodes: Readonly<Record<string, Pick<ChatNodeState, 'deletionGroupId'>>>,
): number {
  if (page !== 'trash') return 0;
  const groupIds = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.deletionGroupId && !isArchiveGroupId(node.deletionGroupId)) {
      groupIds.add(node.deletionGroupId);
    }
  }
  return groupIds.size;
}

export function selectArchivedGroupCountForPage(
  page: PageId,
  nodes: Readonly<Record<string, Pick<ChatNodeState, 'deletionGroupId'>>>,
): number {
  if (page !== 'archived') return 0;
  const groupIds = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (isArchiveGroupId(node.deletionGroupId)) groupIds.add(node.deletionGroupId!);
  }
  return groupIds.size;
}
