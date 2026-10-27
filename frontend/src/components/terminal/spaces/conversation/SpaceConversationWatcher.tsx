import type { PageId } from '../../../../state/commands';
import { useSpaceConversationWatcher } from '../../../../state/spaceConversations/watcher';
import { useOpenSpaceConversation } from './openConversation';

/** Mounted once by the terminal shell: runs Space chat starts and their signals from any area. */
export function SpaceConversationWatcher({ page }: { page: PageId }) {
  const open = useOpenSpaceConversation();
  useSpaceConversationWatcher({ page, onOpen: (card) => { void open(card); } });
  return null;
}

export default SpaceConversationWatcher;
