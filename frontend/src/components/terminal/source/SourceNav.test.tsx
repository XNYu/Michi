import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState } from '../../../state/chatTypes';
import { DEFAULT_PREFS } from '../../../state/prefs';

const api = vi.hoisted(() => ({ fetchSourcePreview: vi.fn(), describePageReference: vi.fn() }));
vi.mock('../../../state/sourceNav/sourceApi', () => api);
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

import { SourceBackBar, SourcePopoverHost } from './SourceNav';
import { PaneMessageList } from '../PaneMessageList';
import {
  openConversationFromSpaces, openExactSourcePopover, registerSourceNavigator, resetSourceNavForTests, type SourceOrigin,
} from '../../../state/sourceNav/sourceNav';

const origin: SourceOrigin = { kind: 'page', backendConnectionId: 'local', workspaceId: 'ws-1', pageId: 'p1', title: 'Michi 0.9 发布' };
const page = { backendConnectionId: 'local', workspaceId: 'ws-1', pageId: 'p1', title: 'Michi 0.9 发布' };
let navigator: { currentOrigin: () => SourceOrigin | null; reveal: ReturnType<typeof vi.fn<(workspaceId: string, nodeId: string) => Promise<boolean>>>; returnTo: ReturnType<typeof vi.fn<(origin: SourceOrigin) => void>> };

beforeEach(() => {
  resetSourceNavForTests();
  api.fetchSourcePreview.mockReset();
  api.describePageReference.mockReset().mockResolvedValue('进展, 风险');
  navigator = { currentOrigin: () => origin, reveal: vi.fn(async (_workspaceId: string, _nodeId: string) => true), returnTo: vi.fn((_origin: SourceOrigin) => {}) };
  registerSourceNavigator(navigator);
});
afterEach(() => { cleanup(); });

describe('Back to page bar', () => {
  it('appears after a jump, stays through later jumps, returns on Back and goes away on ×', async () => {
    render(<SourceBackBar contentWidth={740} />);
    expect(screen.queryByRole('navigation', { name: 'Back to Pages' })).toBeNull();
    await act(async () => { await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n1', messageId: 'm4', page }); });
    const bar = screen.getByRole('navigation', { name: 'Back to Pages' });
    expect(bar.textContent).toContain('From Pages’ “Michi 0.9 发布”');
    expect(bar.style.maxWidth).toBe('740px');
    navigator.currentOrigin = () => null;
    await act(async () => { await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n2', messageId: 'm1' }); });
    expect(screen.getByRole('button', { name: 'Back to “Michi 0.9 发布”' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to “Michi 0.9 发布”' }));
    expect(navigator.returnTo).toHaveBeenCalledWith(origin);
    expect(screen.queryByRole('navigation', { name: 'Back to Pages' })).toBeNull();

    navigator.currentOrigin = () => origin;
    await act(async () => { await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n1', messageId: 'm4' }); });
    fireEvent.click(screen.getByRole('button', { name: 'Close the back bar' }));
    expect(screen.queryByRole('navigation', { name: 'Back to Pages' })).toBeNull();
    expect(navigator.returnTo).toHaveBeenCalledTimes(1);
  });
});

describe('source popover host', () => {
  it('opens the popover from a source link and Continue reveals the conversation it resolved', async () => {
    api.fetchSourcePreview.mockResolvedValue({
      nodeId: 'n1', workspaceId: 'ws-1', workspaceName: 'rabbitholes', title: '排查公证失败', runtimeId: 'claude', state: 'live',
      message: { id: 'm4', role: 'assistant', text: '公证通过', truncated: false, turnId: 't', at: Date.now() },
    });
    render(<SourcePopoverHost />);
    const link = document.createElement('button');
    document.body.appendChild(link);
    act(() => { openExactSourcePopover({ backendConnectionId: 'local' }, { nodeId: 'n1', assistantId: 'm4' }, { anchor: link, page }); });
    // The button is drawn disabled until the preview loads; a click before that does nothing.
    const go = await screen.findByRole('button', { name: /Continue this chat/ }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await act(async () => {});
    expect(navigator.reveal).toHaveBeenCalledWith('ws-1', 'n1');
    expect(screen.queryByRole('dialog')).toBeNull();
    link.remove();
  });
});

describe('highlighted message in the conversation', () => {
  const node: ChatNodeState = {
    nodeId: 'n1', kind: 'chat', chatId: null, projectId: 'ws-1', status: 'idle', followUps: [],
    messages: [
      { id: 'm3', role: 'user', text: '补上之后再跑一次。', toolCalls: [] },
      { id: 'm4', role: 'assistant', text: '公证通过（Accepted）。', toolCalls: [{
        id: 'tc', title: 'mcp__michi-tools__edit_page', status: 'completed',
        output: JSON.stringify({ michiPageWrite: { kind: 'michiPageWrite', resourceKind: 'page', resourceId: 'p1', title: 'Michi 0.9 发布', appliedCount: 1, proposedCount: 1, affectedTargetIds: ['b1'] } }),
      }] },
    ],
  } as unknown as ChatNodeState;
  const list = () => <PaneMessageList node={node} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={false} viewportHeight={800}
    onRetryTurn={() => {}} onEditUserMessage={() => {}} onContinueFollowUp={() => {}} onBranchFollowUp={() => {}} />;

  it('frames the cited reply with the page that references it; its page receipt counts places', async () => {
    const { container } = render(list());
    expect(container.querySelector('[data-source-referenced]')).toBeNull();
    await act(async () => { await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n1', messageId: 'm4', page }); });
    const frame = container.querySelector('[data-source-referenced="true"]')!;
    expect(frame.getAttribute('data-msg-id')).toBe('m4');
    expect(frame.textContent).toContain('Referenced by page “Michi 0.9 发布 · 进展, 风险”');
    expect(frame.querySelector('[data-page-receipt]')?.textContent).toContain('Updated Michi 0.9 发布 · 2 places · 1 waiting for you');
    expect(container.querySelectorAll('[data-source-referenced]')).toHaveLength(1);
  });

  it('a jump from a Home row highlights the message without naming a page', async () => {
    const { container } = render(list());
    await act(async () => { await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n1', messageId: 'm3' }); });
    const frame = container.querySelector('[data-source-referenced="true"]')!;
    expect(frame.getAttribute('data-msg-id')).toBe('m3');
    expect(frame.textContent).not.toContain('Referenced by page');
  });
});
