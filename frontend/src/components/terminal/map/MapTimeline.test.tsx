import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MapTimeline } from './MapTimeline';
import type { ChatNodeState } from '../../../state/chatTypes';

// Mock ResizeObserver for the layout hook
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

function node(p: Partial<ChatNodeState>): ChatNodeState {
  return { nodeId: 'n1', projectId: 'p1', chatId: null, messages: [],
    followUps: [], status: 'idle', kind: 'chat', ...p } as ChatNodeState;
}
const NOW = 1_000_000_000_000;

describe('MapTimeline', () => {
  it('renders a lane name per node', () => {
    const nodes = [node({ nodeId: 'a', title: 'backend' }), node({ nodeId: 'b', title: 'fix-path' })];
    render(<MapTimeline nodes={nodes} now={NOW} onOpenPane={() => {}} onFocus={() => {}} />);
    expect(screen.getByText('backend')).toBeTruthy();
    expect(screen.getByText('fix-path')).toBeTruthy();
  });

  it('labels a non-root lane\'s first event as forked', () => {
    const parentOf = new Map([['b', 'a']]);
    const nodes = [
      node({ nodeId: 'a', title: 'root', branchOverviewEntries: [{ at: NOW - 2000, text: 'root work' }] }),
      node({ nodeId: 'b', title: 'child', branchOverviewEntries: [{ at: NOW - 1000, text: 'child work' }] }),
    ];
    render(<MapTimeline nodes={nodes} now={NOW} onOpenPane={() => {}} onFocus={() => {}} parentOf={parentOf} />);
    expect(screen.getByText(/forked/)).toBeTruthy();
  });

  it('renders break markers for large gaps', () => {
    const HOUR = 3_600_000;
    const nodes = [node({ nodeId: 'a', title: 'cross-day', branchOverviewEntries: [
      { at: NOW - 20 * HOUR, text: 'yesterday session' },
      { at: NOW - 10_000,    text: 'today session' },
    ]})];
    const { container } = render(
      <MapTimeline nodes={nodes} now={NOW} onOpenPane={() => {}} onFocus={() => {}} />
    );
    // Should have break markers (one on axis, one in track)
    const breakMarkers = container.querySelectorAll('[title*="idle"]');
    expect(breakMarkers.length).toBeGreaterThan(0);
  });
});
