import { openSourcePopover } from '../../source';

/** Opens the source popover for a conversation message a window reply cites. */
export interface MetaChatSourcePage {
  pageId: string | null;
  workspaceId: string | null;
  backendConnectionId: string;
  title: string;
}

export interface MetaChatSourceRequest {
  backendConnectionId: string;
  nodeId: string;
  /** The cited message, when the link names one (michi://node/<id>?message=<messageId>). */
  assistantId?: string;
  title: string;
  page: MetaChatSourcePage | null;
}

export function openWindowSource(request: MetaChatSourceRequest): boolean {
  const { page } = request;
  openSourcePopover({
    target: { backendConnectionId: request.backendConnectionId, nodeId: request.nodeId, messageId: request.assistantId ?? null },
    page: page?.pageId && page.workspaceId
      ? { backendConnectionId: page.backendConnectionId, workspaceId: page.workspaceId, pageId: page.pageId, title: page.title }
      : null,
  });
  return true;
}
