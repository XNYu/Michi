import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCallState } from '../../../../state/chatTypes';
import { MetaChatDecorationsContext, type MetaChatDecorations } from '../../../../state/metaChat/metaChatDecorations';
import { MessageBlock } from '../../MessageBlock';
import { AssistantLinkChip } from '../../assistant/AssistantLinks';

const openSpacesPage = vi.hoisted(() => vi.fn(() => Promise.resolve('opened')));
vi.mock('../../../../state/metaChat/spacesPages', () => ({ openSpacesPage }));

afterEach(() => {
  cleanup();
  openSpacesPage.mockClear();
});

const tool = (id: string, title: string): ToolCallState => ({ id, title, status: 'completed', kind: 'other', inputJson: '{"pageId":"pg"}', output: '{}' } as ToolCallState);
const reply: ChatMessage = {
  id: 'a-1', role: 'assistant', text: 'Two threads.', streaming: false,
  toolCalls: [tool('t1', 'Running: @michi/read_page'), tool('t2', 'Running: @michi/list_pages')],
} as unknown as ChatMessage;

function renderReply(decorations: MetaChatDecorations | null) {
  return render(
    <MetaChatDecorationsContext.Provider value={decorations}>
      <MessageBlock m={reply} index={0} isDark={false} onEdit={() => {}} onCopy={() => {}} showThoughts={false}
        fontFamily="inherit" density="comfortable" workspaceId="ws-assistant" backendConnectionId="local" />
    </MetaChatDecorationsContext.Provider>,
  );
}

describe('the Meta agent window decorations on the shared message list', () => {
  it('keeps the plain reply without a provider', () => {
    renderReply(null);
    expect(screen.getByText('> michi')).toBeTruthy();
    expect(document.querySelector('[data-tool-lines]')).toBeNull();
  });

  it('labels the reply, lists each tool call as one line, and adds its cards and divider', () => {
    renderReply({
      assistantLabel: <span>Meta agent</span>,
      toolLine: (t) => (t.id === 't1' ? 'Read Home · 6 blocks' : 'List pages · rabbitholes'),
      toolCards: (tools) => <div data-testid="cards">{tools.length} tools</div>,
      afterMessage: (m) => <div role="separator">From here on: Kiro after {m.id}</div>,
    });
    expect(screen.queryByText('> michi')).toBeNull();
    expect(screen.getByText('Meta agent')).toBeTruthy();
    const lines = [...document.querySelectorAll('[data-tool-lines] [data-tool-line]')].map((el) => el.textContent?.trim());
    expect(lines).toEqual(['▸Read Home · 6 blocks', '▸List pages · rabbitholes']);
    expect(screen.getByTestId('cards').textContent).toBe('2 tools');
    expect(screen.getByRole('separator').textContent).toBe('From here on: Kiro after a-1');
  });
});

describe('michi://page links', () => {
  it('open the page at the linked block', () => {
    render(<AssistantLinkChip link={{ kind: 'page', id: 'pg-release', blockId: 'b-risk' }}>Michi 0.9 发布</AssistantLinkChip>);
    const chip = screen.getByRole('button', { name: /Michi 0.9 发布/ });
    expect(chip.dataset.assistantLink).toBe('page-block');
    fireEvent.click(chip);
    expect(openSpacesPage).toHaveBeenCalledWith({ pageId: 'pg-release', blockId: 'b-risk' });
  });
});
