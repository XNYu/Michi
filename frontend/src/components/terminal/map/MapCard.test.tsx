import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MapCard } from './MapCard';
import type { ChatNodeState } from '../../../state/chatTypes';

function node(p: Partial<ChatNodeState>): ChatNodeState {
  return { nodeId: 'n1', projectId: 'p1', chatId: null, messages: [],
    followUps: [], status: 'idle', kind: 'chat', ...p } as ChatNodeState;
}
const NOW = 1_000_000_000_000;

describe('MapCard (expanded)', () => {
  it('caps the trail at the 3 most recent entries and notes how many are elided', () => {
    const { container } = render(<MapCard now={NOW} ribbon={null} expanded onToggle={() => {}} onOpenPane={() => {}}
      node={node({ title: 'X', branchOverviewEntries: [
        { at: 1, text: '最老的一条' }, { at: 2, text: '第二条' }, { at: 3, text: '第三条' },
        { at: 4, text: '第四条' }, { at: 5, text: '最新进展' },
      ]})} />);
    expect(screen.queryByText('最老的一条')).toBeNull();
    expect(screen.queryByText('第二条')).toBeNull();
    expect(screen.getByText('第三条')).toBeTruthy();
    expect(screen.getByText('第四条')).toBeTruthy();
    expect(container.querySelector('[data-latest="true"]')?.textContent).toContain('最新进展');
    expect(container.querySelector('[data-trail-elided]')?.textContent).toContain('+2 earlier');
  });

  it('open-pane footer calls onOpenPane and stops propagation to toggle', () => {
    const onOpenPane = vi.fn(); const onToggle = vi.fn();
    render(<MapCard now={NOW} ribbon={null} expanded onToggle={onToggle} onOpenPane={onOpenPane}
      node={node({ title: 'X' })} />);
    fireEvent.click(screen.getByRole('button', { name: /Open in pane/ }));
    expect(onOpenPane).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('MapCard (B effects)', () => {
  it('marks unread nodes with data-unread', () => {
    const { container } = render(<MapCard now={NOW} ribbon={null} expanded={false}
      onToggle={() => {}} onOpenPane={() => {}}
      node={node({ title: 'X', lastAssistantAt: NOW, viewedAt: NOW - 1000 })} unread />);
    expect(container.querySelector('[data-unread="true"]')).not.toBeNull();
  });
});
