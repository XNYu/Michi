// frontend/src/components/terminal/map/MapTimeline.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MapTimeline } from './MapTimeline';
import type { ChatNodeState } from '../../../state/chatTypes';

function node(p: Partial<ChatNodeState>): ChatNodeState {
  return { nodeId: 'n1', projectId: 'p1', chatId: null, messages: [],
    followUps: [], status: 'idle', kind: 'chat', ...p } as ChatNodeState;
}
const NOW = 1_000_000_000_000;

describe('MapTimeline', () => {
  it('renders one card per overview entry along a lane', () => {
    const nodes = [node({ nodeId: 'a', title: 'backend', branchOverviewEntries: [
      { at: NOW - 3000, text: 'fork 无日志' },
      { at: NOW - 2000, text: 'PATH 缺 node' },
      { at: NOW - 1000, text: '稳定复现' },
    ]})];
    render(<MapTimeline nodes={nodes} now={NOW} onOpenPane={() => {}} onFocus={() => {}} />);
    expect(screen.getByText('fork 无日志')).toBeTruthy();
    expect(screen.getByText('PATH 缺 node')).toBeTruthy();
    expect(screen.getByText('稳定复现')).toBeTruthy();
  });

  it('renders a lane name per node', () => {
    const nodes = [node({ nodeId: 'a', title: 'backend' }), node({ nodeId: 'b', title: 'fix-path' })];
    render(<MapTimeline nodes={nodes} now={NOW} onOpenPane={() => {}} onFocus={() => {}} />);
    expect(screen.getByText('backend')).toBeTruthy();
    expect(screen.getByText('fix-path')).toBeTruthy();
  });

  it('renders a seam element when a big time gap exists', () => {
    const D = 24 * 3600_000;
    const nodes = [node({ nodeId: 'a', title: 'x', branchOverviewEntries: [
      { at: NOW - 5 * D, text: 'early' }, { at: NOW, text: 'late' },
    ]})];
    const { container } = render(<MapTimeline nodes={nodes} now={NOW} onOpenPane={() => {}} onFocus={() => {}} />);
    expect(container.querySelector('[data-timeline-seam]')).not.toBeNull();
  });
});
