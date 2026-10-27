import React from 'react';
import type { HomeSectionItem, HomeSectionKey, SpaceActivityItem } from 'michi-shared';
import { openNativePageRoute } from '../SpacesPage';
import { revealPageBlock } from './HomeDocument';
import { homeRowAction } from './homeFormat';
import { useSpacesSourceNav } from './homeLinks';

/** A Michi conversation a home row names, and the message to show when the row is about one. */
export interface HomeThreadTarget {
  nodeId: string;
  /** The conversation's workspace when the row knows it; null asks the backend where it is now (moved, or gone). */
  workspaceId: string | null;
  messageId?: string | null;
  /** Continue puts the cursor in the conversation's composer. */
  focus?: boolean;
}

/**
 * Where the home pages' rows lead: a conversation opens in the conversation
 * area with a way back to Spaces, and a page change opens its page with the
 * block flashed. `currentPageId` is the page on screen, which flashes in
 * place instead of reopening.
 */
export function useHomeNavigation(backendConnectionId: string, currentPageId: string | null) {
  const sourceNav = useSpacesSourceNav();
  // A reveal outlives this page on purpose: opening another page unmounts the home, and the
  // reveal then waits for that page to render the block. It gives up on its own.
  const cancelRef = React.useRef<(() => void) | null>(null);

  const openThread = React.useCallback((thread: HomeThreadTarget) => sourceNav.openConversationFromSpaces({
    backendConnectionId, workspaceId: thread.workspaceId, nodeId: thread.nodeId, messageId: thread.messageId ?? null, focus: thread.focus === true,
  }), [backendConnectionId, sourceNav]);

  const openPage = React.useCallback((pageId: string, workspaceId: string, blockId: string | null) => {
    cancelRef.current?.();
    if (pageId !== currentPageId) openNativePageRoute({ pageId, workspaceId, backendConnectionId });
    cancelRef.current = blockId ? revealPageBlock(blockId) : null;
  }, [backendConnectionId, currentPageId]);

  const openSectionItem = React.useCallback((item: HomeSectionItem, section: HomeSectionKey | null) => {
    const target = item.target;
    if (target.kind === 'page') openPage(target.pageId, item.workspaceId ?? '', target.blockId);
    else void openThread({ nodeId: target.nodeId, workspaceId: target.workspaceId, messageId: target.messageId, focus: homeRowAction(section, item) === 'Continue' });
  }, [openPage, openThread]);

  const openActivity = React.useCallback((item: SpaceActivityItem) => {
    if (item.kind === 'conversation') void openThread({ nodeId: item.threadNodeId, workspaceId: item.workspaceId });
    else openPage(item.pageId, item.workspaceId, null);
  }, [openPage, openThread]);

  return { openThread, openPage, openSectionItem, openActivity };
}
