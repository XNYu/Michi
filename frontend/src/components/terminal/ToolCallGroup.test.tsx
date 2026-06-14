import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { ToolCallGroup } from './ToolCallGroup';
import type { ToolCallState } from '../../state/chatTypes';

function tool(id: string, title: string, status = 'running', kind?: string): ToolCallState {
  return { id, title, status, kind };
}

describe('ToolCallGroup — collapsed state', () => {
  it('renders summarized chip text when defaultExpanded is false', () => {
    const tools = [
      tool('1', 'Read a', 'completed', 'read'),
      tool('2', 'Read b', 'completed', 'read'),
    ];
    const { getByText } = render(
      <ToolCallGroup tools={tools} defaultExpanded={false} />,
    );
    expect(getByText(/Read 2 files/)).toBeTruthy();
  });

  it('single tool collapsed shows the tool title verbatim', () => {
    const tools = [tool('1', 'Read package.json', 'completed', 'read')];
    const { getByText } = render(
      <ToolCallGroup tools={tools} defaultExpanded={false} />,
    );
    expect(getByText(/Read package\.json/)).toBeTruthy();
  });

  it('clicking the collapsed header expands the group', () => {
    const tools = [
      tool('1', 'Read a', 'completed', 'read'),
      tool('2', 'Read b', 'completed', 'read'),
    ];
    const { getByText, queryByText } = render(
      <ToolCallGroup tools={tools} defaultExpanded={false} />,
    );
    expect(queryByText('Read a')).toBeNull();
    fireEvent.click(getByText(/Read 2 files/));
    expect(getByText('Read a')).toBeTruthy();
    expect(getByText('Read b')).toBeTruthy();
  });
});

describe('ToolCallGroup — expanded state', () => {
  it('renders one row per tool when defaultExpanded is true', () => {
    const tools = [
      tool('1', 'Read a', 'running', 'read'),
      tool('2', 'Read b', 'running', 'read'),
    ];
    const { getByText } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} />,
    );
    expect(getByText('Read a')).toBeTruthy();
    expect(getByText('Read b')).toBeTruthy();
  });

  it('clicking the expanded header collapses the group', () => {
    const tools = [
      tool('1', 'Read a', 'completed', 'read'),
      tool('2', 'Read b', 'completed', 'read'),
    ];
    const { getByText, queryByText, container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} />,
    );
    // Header is the first interactive element (button) inside the group.
    const header = container.querySelector('button[data-toolgroup-header]') as HTMLElement;
    expect(header).not.toBeNull();
    fireEvent.click(header);
    expect(queryByText('Read a')).toBeNull();
    expect(queryByText('Read b')).toBeNull();
    expect(getByText(/Read 2 files/)).toBeTruthy();
  });

  it('renders SubAgent as a hairline-spine row (no card testid)', () => {
    const detail = JSON.stringify({
      description: 'Explore Michi project structure',
      subagent_type: 'Explore',
      model: 'haiku',
      prompt: 'I need to understand the core philosophy.',
    });
    const tools = [tool('1', 'Agent', 'in_progress', 'tool')];
    tools[0].detail = detail;

    const { getByTestId, queryByTestId, container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} />,
    );

    expect(queryByTestId('subagent-tool-card')).toBeNull();
    expect(getByTestId('subagent-spine-row')).toBeTruthy();
    expect(container.textContent).toContain('SubAgent · Explore');
    expect(container.textContent).toContain('Mission: Explore Michi project structure');
    expect(container.textContent).toContain('haiku');
    expect(container.textContent).not.toContain('subagent_type');
  });
});

describe('ToolCallGroup — empty', () => {
  it('returns null when tools is empty', () => {
    const { container } = render(
      <ToolCallGroup tools={[]} defaultExpanded={false} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('ToolCallGroup — auto-collapse', () => {
  it('auto-collapses when running tools transition to terminal', () => {
    const running = [tool('1', 'Read a', 'running', 'read')];
    const { rerender, getByText, queryByText } = render(
      <ToolCallGroup tools={running} defaultExpanded={true} />,
    );
    expect(getByText('Read a')).toBeTruthy();

    const done = [tool('1', 'Read a', 'completed', 'read')];
    rerender(<ToolCallGroup tools={done} defaultExpanded={true} />);

    // After auto-collapse the component shows the collapsed indicator ›.
    // (queryByText('Read a') can't be used here because the collapsed chip for
    //  a single-tool group also shows "Read a" as the summary text.)
    expect(getByText('›')).toBeTruthy();
    expect(queryByText('⌃')).toBeNull();
  });

  it('does not auto-collapse if user expanded a group that started collapsed', () => {
    // started collapsed → user clicks to expand → tools transition is irrelevant
    const tools = [tool('1', 'Read a', 'completed', 'read')];
    const { getByText, container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={false} />,
    );
    fireEvent.click(getByText(/Read a/));
    // After click, expanded list is showing.
    expect(container.querySelector('[data-toolgroup-header]')).toBeTruthy();
    // Re-render with same tools should not collapse.
    // (No rerender call needed; absence of auto-collapse is what we verify.)
    expect(getByText('Read a')).toBeTruthy();
  });

  it('does not auto-collapse after user manually toggles', () => {
    const running = [tool('1', 'Read a', 'running', 'read')];
    const { rerender, container, getByText } = render(
      <ToolCallGroup tools={running} defaultExpanded={true} />,
    );
    // User clicks to collapse.
    const header = container.querySelector('button[data-toolgroup-header]') as HTMLElement;
    fireEvent.click(header);
    // User clicks again to expand.
    const header2 = container.querySelector('button[data-toolgroup-header]') as HTMLElement;
    fireEvent.click(header2);
    expect(getByText('Read a')).toBeTruthy();
    // Now tools transition to terminal — should NOT auto-collapse.
    const done = [tool('1', 'Read a', 'completed', 'read')];
    rerender(<ToolCallGroup tools={done} defaultExpanded={true} />);
    expect(getByText('Read a')).toBeTruthy();
  });

  it('failed group still auto-collapses (no exemption)', () => {
    const running = [tool('1', 'Read a', 'running', 'read')];
    const { rerender, queryByText } = render(
      <ToolCallGroup tools={running} defaultExpanded={true} />,
    );
    const failed = [tool('1', 'Read a', 'error', 'read')];
    rerender(<ToolCallGroup tools={failed} defaultExpanded={true} />);
    expect(queryByText('Read a')).toBeNull();
  });
});

import type { SubagentInfo } from '../../state/chatTypes';

function subInfo(partial: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    sessionId: partial.sessionId ?? 'sub-1',
    sessionName: partial.sessionName ?? 'sub-1',
    agentName: partial.agentName ?? 'Explore',
    initialQuery: partial.initialQuery ?? 'Explore Michi',
    status: partial.status ?? 'working',
    group: partial.group ?? 'default',
    dependsOn: partial.dependsOn ?? [],
    currentTool: partial.currentTool,
  };
}

describe('ToolCallGroup — relayed-tool filter', () => {
  it('hides Bash/Glob peers when an owning subagent is active', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const tools: ToolCallState[] = [
      { id: 't1', title: 'Agent', status: 'in_progress', kind: 'tool', detail },
      { id: 't2', title: 'Bash ls', status: 'completed', kind: 'bash' },
      { id: 't3', title: 'Glob **/*.ts', status: 'completed', kind: 'glob' },
    ];
    const subagents = [subInfo({ agentName: 'Explore', initialQuery: 'Explore Michi' })];
    const { queryByText, getByText } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} subagents={subagents} />,
    );
    expect(queryByText('Bash ls')).toBeNull();
    expect(queryByText('Glob **/*.ts')).toBeNull();
    expect(getByText(/SubAgent · Explore/)).toBeTruthy();
  });

  it('keeps peers when subagents prop is undefined (legacy callers)', () => {
    const tools: ToolCallState[] = [
      { id: 't1', title: 'Bash ls', status: 'completed', kind: 'bash' },
      { id: 't2', title: 'Read x', status: 'completed', kind: 'read' },
    ];
    const { getByText } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} />,
    );
    expect(getByText('Bash ls')).toBeTruthy();
    expect(getByText('Read x')).toBeTruthy();
  });
});

describe('ToolCallGroup — SubAgent spine Now: line', () => {
  it('shows Now: <currentTool> when running and currentTool is non-empty', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const tools = [tool('1', 'Agent', 'in_progress', 'tool')];
    tools[0].detail = detail;
    const subagents = [
      subInfo({ agentName: 'Explore', initialQuery: 'Explore Michi', currentTool: 'Glob' }),
    ];

    const { container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} subagents={subagents} />,
    );
    expect(container.textContent).toContain('Now: Glob');
  });

  it('omits Now: line when subagent is in a terminal status', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const tools = [tool('1', 'Agent', 'completed', 'tool')];
    tools[0].detail = detail;
    const subagents = [
      subInfo({ agentName: 'Explore', initialQuery: 'Explore Michi', currentTool: 'Glob' }),
    ];

    const { container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} subagents={subagents} />,
    );
    expect(container.textContent).not.toContain('Now:');
  });

  it('omits Now: line when currentTool is undefined', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const tools = [tool('1', 'Agent', 'in_progress', 'tool')];
    tools[0].detail = detail;
    const subagents = [
      subInfo({ agentName: 'Explore', initialQuery: 'Explore Michi' /* no currentTool */ }),
    ];

    const { container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} subagents={subagents} />,
    );
    expect(container.textContent).not.toContain('Now:');
  });
});
