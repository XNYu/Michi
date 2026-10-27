import { PAGE_COMPONENT_LIMITS } from 'michi-shared';

export const PAGE_HELPER_DRAFT_EVENT = 'michi:page-helper-draft';

export interface PageHelperDraftRequest {
  requestId?: number;
  backendConnectionId: string;
  workspaceId: string;
  pageId: string;
  text: string;
  blockContext?: { blockId: string; title: string; content: string };
}

let requestSequence = 0;
const pendingRequests: PageHelperDraftRequest[] = [];

export function dispatchPageHelperDraft(request: PageHelperDraftRequest): void {
  const text = request.text.trim();
  if (!text || text.length > PAGE_COMPONENT_LIMITS.draftChars) return;
  const queued = { ...request, requestId: ++requestSequence, text };
  pendingRequests.push(queued);
  window.dispatchEvent(new CustomEvent<PageHelperDraftRequest>(PAGE_HELPER_DRAFT_EVENT, {
    detail: queued,
  }));
}

export function pendingPageHelperDrafts(identity: Pick<PageHelperDraftRequest, 'backendConnectionId' | 'workspaceId' | 'pageId'>): PageHelperDraftRequest[] {
  return pendingRequests.filter((request) => request.backendConnectionId === identity.backendConnectionId
    && request.workspaceId === identity.workspaceId && request.pageId === identity.pageId);
}

export function consumePageHelperDraft(requestId: number): void {
  const index = pendingRequests.findIndex((request) => request.requestId === requestId);
  if (index >= 0) pendingRequests.splice(index, 1);
}
