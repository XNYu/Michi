import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumePageHelperDraft, dispatchPageHelperDraft, pendingPageHelperDrafts, PAGE_HELPER_DRAFT_EVENT } from './pageHelperDraft';

afterEach(() => {
  vi.restoreAllMocks();
  const pending = pendingPageHelperDrafts({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p' });
  pending.forEach((request) => request.requestId !== undefined && consumePageHelperDraft(request.requestId));
});

describe('page helper draft requests', () => {
  it('queues by backend, workspace, and page and emits a scoped draft-only event', () => {
    const listener = vi.fn();
    window.addEventListener(PAGE_HELPER_DRAFT_EVENT, listener);
    dispatchPageHelperDraft({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p', text: '  Help debug  ' });
    window.removeEventListener(PAGE_HELPER_DRAFT_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pendingPageHelperDrafts({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p' })[0].text).toBe('Help debug');
    expect(pendingPageHelperDrafts({ backendConnectionId: 'other', workspaceId: 'w', pageId: 'p' })).toEqual([]);
  });

  it('rejects empty and oversized requests', () => {
    dispatchPageHelperDraft({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p', text: '  ' });
    dispatchPageHelperDraft({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p', text: 'x'.repeat(8001) });
    expect(pendingPageHelperDrafts({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p' })).toEqual([]);
  });

  it('accepts the shared component draft limit of 8,000 characters', () => {
    dispatchPageHelperDraft({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p', text: 'x'.repeat(8000) });
    expect(pendingPageHelperDrafts({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p' })[0]?.text).toHaveLength(8000);
  });
});
