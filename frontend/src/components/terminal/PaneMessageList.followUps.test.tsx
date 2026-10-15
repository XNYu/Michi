import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaneMessageList } from './PaneMessageList';
import type { ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';

const node: ChatNodeState = {
  nodeId: 'followups-node', kind: 'chat', chatId: null, projectId: 'project',
  status: 'idle', messages: [], followUps: ['Trace the tool result', 'Check parsing', 'Review trust boundaries'],
};
const prefs = { ...DEFAULT_PREFS, enableFollowUps: true };
const noop = () => {};

function list(overrides: Partial<ChatNodeState> = {}, disabled = false, enableFollowUps = true) {
  return <PaneMessageList
    node={{ ...node, ...overrides }} prefs={{ ...prefs, enableFollowUps }} contentStyle={{}}
    streaming={overrides.status === 'streaming'} viewportHeight={800}
    onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop}
    followUpsDisabled={disabled}
  />;
}

describe('PaneMessageList follow-ups presentation', () => {
  it('renders an unnumbered section and collapses without removing its suggestions', () => {
    render(list());
    const section = screen.getByRole('region', { name: 'Suggested follow-ups' });
    expect(within(section).getByRole('heading', { name: 'Explore further' })).toBeTruthy();
    expect(section.querySelectorAll('.t-followup-row')).toHaveLength(3);
    expect(section.querySelector('.t-followup-num, .t-followup-text svg')).toBeNull();
    const collapse = within(section).getByRole('button', { name: 'Collapse follow-ups' });
    const content = document.getElementById(collapse.getAttribute('aria-controls')!)!;
    fireEvent.click(collapse);
    expect(content.hidden).toBe(true);
    expect(within(section).queryByRole('button', { name: /Continue follow-up/ })).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'Expand follow-ups' }));
    expect(content.hidden).toBe(false);
    expect(within(section).getAllByRole('button', { name: /Continue follow-up/ })).toHaveLength(3);
  });

  it('keeps loading free of numbered or actionable suggestions', () => {
    render(list({ status: 'streaming', followUps: [], followUpsGenerating: true }));
    const section = screen.getByRole('region', { name: 'Suggested follow-ups' });
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(within(section).getByRole('status').textContent).toBe('Preparing next steps...');
    expect(section.querySelectorAll('.t-followup-skeleton')).toHaveLength(3);
    expect(section.querySelector('.t-followup-row, .t-followup-num')).toBeNull();
  });

  it('hides empty and disabled-by-preference sections', () => {
    const { rerender } = render(list({ followUps: [] }));
    expect(screen.queryByRole('region', { name: 'Suggested follow-ups' })).toBeNull();
    rerender(list({}, false, false));
    expect(screen.queryByRole('region', { name: 'Suggested follow-ups' })).toBeNull();
  });

  it('keeps both actions disabled in a read-only pane', () => {
    render(list({}, true));
    for (const button of screen.getAllByRole('button', { name: /^(Continue|Branch) follow-up/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('keeps send and branch callbacks independent through the real section', () => {
    const onContinue = vi.fn();
    const onBranch = vi.fn();
    render(React.cloneElement(list(), { onContinueFollowUp: onContinue, onBranchFollowUp: onBranch }));
    fireEvent.click(screen.getAllByRole('button', { name: /^Continue follow-up/ })[0]);
    expect(onContinue).toHaveBeenCalledWith(node.followUps[0]);
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /^Branch follow-up/ })[1]);
    expect(onBranch).toHaveBeenCalledWith(node.followUps[1]);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
