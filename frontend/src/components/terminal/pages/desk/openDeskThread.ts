import type { DeskThread } from 'michi-shared';
import type { PageId } from '../../../../state/commands';
import { navigateToNode, type NavigateToNodeDeps } from '../../../../state/navigateToNode';

export function openDeskThread(
  deps: NavigateToNodeDeps,
  thread: Pick<DeskThread, 'focusNodeId' | 'projectId'>,
  onNav: (page: PageId) => void,
): void {
  navigateToNode(deps, thread.focusNodeId, thread.projectId);
  onNav('dashboard');
}
