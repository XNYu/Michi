import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchSourcePreview: vi.fn(), describePageReference: vi.fn() }));
vi.mock('./sourceApi', () => api);
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import {
  claimSourceJump, dismissSourceBack, getSourceNavState, openConversationFromSpaces, openExactSourcePopover, openPopoverSource,
  registerSourceNavigator, resetSourceNavForTests, returnToSourceOrigin, useSourceJump, type SourceOrigin,
} from './sourceNav';

const origin: SourceOrigin = { kind: 'page', backendConnectionId: 'local', workspaceId: 'ws-1', pageId: 'p1', title: 'Michi 0.9 发布' };
const page = { backendConnectionId: 'local', workspaceId: 'ws-1', pageId: 'p1', title: 'Michi 0.9 发布' };

function scroller(top: number): HTMLElement {
  const col = document.createElement('div');
  col.className = 'terminal-content-col';
  const doc = document.createElement('div');
  doc.className = 'michi-doc';
  doc.style.overflowY = 'auto';
  Object.defineProperty(doc, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(doc, 'clientHeight', { configurable: true, value: 800 });
  doc.scrollTop = top;
  col.appendChild(doc);
  document.body.appendChild(col);
  return doc;
}

let navigator: ReturnType<typeof makeNavigator>;
function makeNavigator() {
  return {
    currentOrigin: vi.fn((): SourceOrigin | null => origin),
    reveal: vi.fn(async (_workspaceId: string, _nodeId: string) => true),
    returnTo: vi.fn((_origin: SourceOrigin) => {}),
  };
}
beforeEach(() => {
  resetSourceNavForTests();
  api.fetchSourcePreview.mockReset();
  api.describePageReference.mockReset().mockResolvedValue(null);
  toast.error.mockReset();
  navigator = makeNavigator();
  registerSourceNavigator(navigator);
});
afterEach(() => { for (const node of [...document.body.children]) node.remove(); });

describe('source navigation', () => {
  it('opens the popover under the clicked link and remembers where Spaces was', () => {
    const doc = scroller(340);
    const link = document.createElement('button');
    doc.appendChild(link);
    link.addEventListener('click', () => openExactSourcePopover({ backendConnectionId: 'local' }, { nodeId: 'n1', turnId: 't', assistantId: 'm4' }, { page }));
    link.click();
    expect(getSourceNavState().popover).toEqual({
      target: { backendConnectionId: 'local', nodeId: 'n1', messageId: 'm4' }, anchor: link, page, origin,
      scroll: { selector: '.terminal-content-col .michi-doc', top: 340 },
    });
  });

  it('Continue opens the conversation at the message, marks it with the citing blocks and asks for the composer', async () => {
    api.describePageReference.mockResolvedValue('进展, 风险');
    const link = document.createElement('button');
    document.body.appendChild(link);
    openExactSourcePopover({ backendConnectionId: 'local' }, { nodeId: 'n1', assistantId: 'm4' }, { anchor: link, page });
    await act(async () => { expect(await openPopoverSource(true, { nodeId: 'n1', workspaceId: 'ws-1', messageId: 'm4' })).toBe(true); });
    expect(navigator.reveal).toHaveBeenCalledWith('ws-1', 'n1');
    const state = getSourceNavState();
    expect(state.popover).toBeNull();
    expect(state.back).toEqual({ origin, scroll: null });
    expect(state.reference).toMatchObject({ nodeId: 'n1', messageId: 'm4', focus: 'composer', label: 'Michi 0.9 发布 · 进展, 风险' });
    expect(api.describePageReference).toHaveBeenCalledWith(page, 'm4');
  });

  it('Open keeps the cursor out of the composer; a jump is carried out once', async () => {
    await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n1', messageId: 'm4', page });
    const { result, rerender } = renderHook(() => useSourceJump('n1'));
    expect(result.current).toMatchObject({ messageId: 'm4', focus: 'message' });
    expect(renderHook(() => useSourceJump('n2')).result.current).toBeNull();
    claimSourceJump(result.current!.token);
    await act(async () => { await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n1', messageId: 'm2', focus: true }); });
    rerender();
    expect(result.current).toMatchObject({ messageId: 'm2', focus: 'composer' });
    expect(getSourceNavState().reference?.label).toBeNull();
  });

  it('Back returns to the page at the scroll position it had and clears the bar; closing the bar only clears it', async () => {
    const before = scroller(420);
    await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n1', messageId: 'm4', anchor: before.appendChild(document.createElement('button')) });
    expect(getSourceNavState().back?.scroll).toEqual({ selector: '.terminal-content-col .michi-doc', top: 420 });
    before.parentElement!.remove();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    returnToSourceOrigin();
    expect(navigator.returnTo).toHaveBeenCalledWith(origin);
    expect(getSourceNavState()).toMatchObject({ back: null, reference: null });
    frames.shift()!(0);
    const after = scroller(0);
    frames.shift()!(0);
    expect(after.scrollTop).toBe(420);
    vi.restoreAllMocks();

    await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n1', messageId: 'm4' });
    dismissSourceBack();
    expect(getSourceNavState()).toMatchObject({ back: null, reference: null });
    expect(navigator.returnTo).toHaveBeenCalledTimes(1);
  });
});
