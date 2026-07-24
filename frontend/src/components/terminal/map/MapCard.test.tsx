import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MapCard } from './MapCard';
import type { ChatNodeState } from '../../../state/chatTypes';

function node(p: Partial<ChatNodeState>): ChatNodeState {
  return { nodeId: 'n1', projectId: 'p1', chatId: null, messages: [],
    followUps: [], status: 'idle', kind: 'chat', ...p } as ChatNodeState;
}
const NOW = 1_000_000_000_000;

describe('MapCard (collapsed)', () => {
  it('renders title and first sentence of latest overview', () => {
    render(<MapCard node={node({ title: '签名/公证影响?',
      branchOverviewEntries: [{ at: 1, text: '正在验证 Gatekeeper 拦截。细节...' }] })}
      ribbon={null} now={NOW} expanded={false} onToggle={() => {}} onOpenPane={() => {}} />);
    expect(screen.getByText('签名/公证影响?')).toBeTruthy();
    expect(screen.getByText('正在验证 Gatekeeper 拦截。')).toBeTruthy();
  });

  it('renders ribbon when provided', () => {
    render(<MapCard node={node({ title: 'X' })} ribbon="会不会是 Gatekeeper"
      now={NOW} expanded={false} onToggle={() => {}} onOpenPane={() => {}} />);
    expect(screen.getByText(/会不会是 Gatekeeper/)).toBeTruthy();
  });

  it('does NOT render ribbon element when ribbon is null', () => {
    const { container } = render(<MapCard node={node({ title: 'X' })} ribbon={null}
      now={NOW} expanded={false} onToggle={() => {}} onOpenPane={() => {}} />);
    expect(container.querySelector('[data-map-ribbon]')).toBeNull();
  });

  it('applies streaming heat class when streaming', () => {
    const { container } = render(<MapCard node={node({ title: 'X', status: 'streaming' })}
      ribbon={null} now={NOW} expanded={false} onToggle={() => {}} onOpenPane={() => {}} />);
    expect(container.querySelector('[data-heat="streaming"]')).not.toBeNull();
  });
});

describe('MapCard (expanded)', () => {
  it('shows full overview trail with last entry highlighted', () => {
    const { container } = render(<MapCard now={NOW} ribbon={null} expanded onToggle={() => {}} onOpenPane={() => {}}
      node={node({ title: 'X', branchOverviewEntries: [
        { at: 1, text: '第一步进展' }, { at: 2, text: '第二步进展' }, { at: 3, text: '最新进展' },
      ]})} />);
    expect(screen.getByText('第一步进展')).toBeTruthy();
    expect(screen.getByText('第二步进展')).toBeTruthy();
    // The last trail entry text also appears in the collapsed body summary
    // (latestOverviewFirstSentence), so target the highlighted trail row by attribute.
    const last = container.querySelector('[data-latest="true"]');
    expect(last).not.toBeNull();
    expect(last?.textContent).toContain('最新进展');
  });

  it('shows last assistant reply excerpt', () => {
    render(<MapCard now={NOW} ribbon={null} expanded onToggle={() => {}} onOpenPane={() => {}}
      node={node({ title: 'X', messages: [
        { id: 'a1', role: 'assistant', text: 'spctl 判定 accepted,下一步查 entitlements', toolCalls: [] },
      ] as any })} />);
    expect(screen.getByText(/spctl 判定 accepted/)).toBeTruthy();
  });

  it('open-pane button calls onOpenPane and stops propagation to toggle', () => {
    const onOpenPane = vi.fn(); const onToggle = vi.fn();
    render(<MapCard now={NOW} ribbon={null} expanded onToggle={onToggle} onOpenPane={onOpenPane}
      node={node({ title: 'X' })} />);
    fireEvent.click(screen.getByRole('button', { name: /打开 pane/ }));
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

  it('streaming card carries the breathe class', () => {
    const { container } = render(<MapCard now={NOW} ribbon={null} expanded={false}
      onToggle={() => {}} onOpenPane={() => {}} node={node({ title: 'X', status: 'streaming' })} />);
    expect(container.querySelector('.map-card--breathe')).not.toBeNull();
  });
});
