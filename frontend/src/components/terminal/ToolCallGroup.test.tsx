import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, fireEvent, waitFor, within } from '@testing-library/react';
import { ToolCallGroup } from './ToolCallGroup';
import type { ToolCallState } from '../../state/chatTypes';
import { AgentBlockStyleOverride } from '../../state/prefs';

function tool(id: string, title: string, status = 'running', kind?: string): ToolCallState {
  return { id, title, status, kind };
}

describe('ToolCallGroup — expanded state', () => {
  it('shows the completed label on hydrated ask_user rows and expanded payloads without changing raw data', () => {
    const raw = JSON.stringify([{
      id: 'ask-1', title: 'Running: @michi/ask_user', status: 'completed', kind: 'other',
      inputJson: '{"questions":[{"question":"First verification choice?"}]}',
      output: '{"answers":{"First verification choice?":"Alpha"}}',
    }]);
    const tools = JSON.parse(raw) as ToolCallState[];
    for (const style of ['plain', 'card', 'terminal'] as const) {
      const { container, getByText, unmount } = render(
        <AgentBlockStyleOverride.Provider value={style}>
          <ToolCallGroup tools={tools} defaultExpanded={false} />
        </AgentBlockStyleOverride.Provider>,
      );
      expect(container.textContent).toContain('Completed: @michi/ask_user');
      expect(container.textContent).not.toContain('Running: @michi/ask_user');
      expect(container.textContent).not.toContain('Alpha');
      fireEvent.click(getByText('Completed: @michi/ask_user'));
      expect(container.textContent).toContain('Alpha');
      expect(container.textContent).toContain('Completed: @michi/ask_user');
      expect(container.textContent).not.toContain('Running: @michi/ask_user');
      expect(JSON.stringify(tools)).toBe(raw);
      unmount();
    }
  });

  it('shows each tool purpose on expanded multi-tool rows (card + plain)', () => {
    const tools: ToolCallState[] = [
      {
        id: '1',
        title: 'Read',
        status: 'completed',
        kind: 'read',
        inputJson: JSON.stringify({
          __tool_use_purpose: 'Inspect the workspace root',
          operations: [{ mode: 'Line', path: '/workspace/example-app' }],
        }),
      },
      {
        id: '2',
        title: 'Read',
        status: 'completed',
        kind: 'read',
        detail: '/workspace/example-app/package.json',
        inputJson: JSON.stringify({
          __tool_use_purpose: 'Check the project manifest to understand the package definition',
          operations: [{ mode: 'Line', path: '/workspace/example-app/package.json' }],
        }),
      },
      {
        id: '3',
        title: 'Bash',
        status: 'completed',
        kind: 'bash',
        inputJson: JSON.stringify({
          __tool_use_purpose: 'Find packageInfo files',
          command: 'find /workspace/example-app -maxdepth 2 -name package.json',
        }),
      },
    ];

    for (const style of ['plain', 'card', 'terminal'] as const) {
      const { getByText, unmount } = render(
        <AgentBlockStyleOverride.Provider value={style}>
          <ToolCallGroup tools={tools} defaultExpanded />
        </AgentBlockStyleOverride.Provider>,
      );
      expect(getByText('Inspect the workspace root')).toBeTruthy();
      expect(getByText('Check the project manifest to understand the package definition')).toBeTruthy();
      expect(getByText('Find packageInfo files')).toBeTruthy();
      unmount();
    }
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
    const row = getByTestId('subagent-spine-row');
    expect(row.textContent).toContain('SubAgent · Explore');
    // One line: the mission stands in until the roster says what it does.
    expect(row.querySelectorAll('[data-testid="subagent-summary"]')).toHaveLength(1);
    expect(row.textContent).toContain('Explore Michi project structure');
    expect(row.textContent).toContain('working');
    expect(container.textContent).not.toContain('subagent_type');
  });
});

describe('ToolCallGroup — motion structure', () => {
  const styles = ['plain', 'card', 'terminal'] as const;
  const withStyle = (style: (typeof styles)[number], ui: React.ReactElement) => (
    <AgentBlockStyleOverride.Provider value={style}>{ui}</AgentBlockStyleOverride.Provider>
  );
  const listed: ToolCallState = {
    id: '1',
    title: 'Bash ls',
    status: 'completed',
    kind: 'bash',
    inputJson: JSON.stringify({ __tool_use_purpose: 'List the files', command: 'ls' }),
    output: 'file-a file-b',
  };

  it.each(styles)('%s: a second tool grows a header above the same row, its open payload kept', (style) => {
    const { container, getByText, rerender } = render(withStyle(style, <ToolCallGroup tools={[listed]} defaultExpanded />));
    expect(container.querySelector('[data-toolgroup-header]')).toBeNull();
    const root = container.firstElementChild;
    const row = getByText('List the files');
    fireEvent.click(row);
    expect(container.textContent).toContain('file-a file-b');

    rerender(withStyle(style, <ToolCallGroup tools={[listed, tool('2', 'Read b', 'running', 'read')]} defaultExpanded />));
    expect(container.querySelector('[data-toolgroup-header]')).not.toBeNull();
    // No structure swap: the container and the first row are the same nodes.
    expect(container.firstElementChild).toBe(root);
    expect(getByText('List the files')).toBe(row);
    expect(container.textContent).toContain('file-a file-b');
  });

  it('auto-collapse keeps the header; the outgoing label and rows leave out of the a11y tree', async () => {
    const running = [tool('1', 'Read a', 'running', 'read'), tool('2', 'Read b', 'running', 'read')];
    const { container, getByText, queryByText, rerender } = render(<ToolCallGroup tools={running} defaultExpanded />);
    const header = container.querySelector('button[data-toolgroup-header]') as HTMLElement;
    expect(within(header).getByText('running tools').closest('[aria-hidden="true"]')).toBeNull();

    rerender(<ToolCallGroup tools={[tool('1', 'Read a', 'completed', 'read'), tool('2', 'Read b', 'completed', 'read')]} defaultExpanded />);
    expect(container.querySelector('button[data-toolgroup-header]')).toBe(header);
    expect(header.textContent).toContain('▸');
    // While they animate out, the old label and the rows are hidden and inert.
    expect(getByText('running tools').closest('[aria-hidden="true"]')).not.toBeNull();
    const leavingRow = getByText('Read a');
    expect(leavingRow.closest('[inert]')).not.toBeNull();
    expect(leavingRow.closest('[aria-hidden="true"]')).not.toBeNull();
    await waitFor(() => {
      expect(queryByText('running tools')).toBeNull();
      expect(queryByText('Read a')).toBeNull();
    });
    // Reopening shows the rows settled and live again.
    fireEvent.click(header);
    expect(getByText('Read a').closest('[inert]')).toBeNull();
  });

  it.each(styles)('%s: a row that fails while shown flashes once; one failed on mount does not', (style) => {
    const live = render(withStyle(style, <ToolCallGroup tools={[tool('1', 'Bash npm test', 'running', 'bash')]} defaultExpanded />));
    expect(live.container.querySelector('[data-fail-flash]')).toBeNull();
    live.rerender(withStyle(style, <ToolCallGroup tools={[tool('1', 'Bash npm test', 'failed', 'bash')]} defaultExpanded />));
    expect(live.container.querySelectorAll('[data-fail-flash]')).toHaveLength(1);
    live.unmount();

    const hydrated = render(withStyle(style, <ToolCallGroup tools={[tool('1', 'Bash npm test', 'failed', 'bash')]} defaultExpanded={false} />));
    expect(hydrated.container.querySelector('[data-fail-flash]')).toBeNull();
  });
});

/**
 * TPane leaves follow mode only when the transcript height changes within the
 * two frames after a click (TPane userClickLayoutRef). A toggled body must so
 * commit a height different from the one before the click, in the click's own
 * commit, not a frame later when its tween first moves.
 */
describe('ToolCallGroup — user toggles change height in the click commit', () => {
  const styles = ['plain', 'card', 'terminal'] as const;
  const withStyle = (style: (typeof styles)[number], ui: React.ReactElement) => (
    <AgentBlockStyleOverride.Provider value={style}>{ui}</AgentBlockStyleOverride.Provider>
  );
  const purposeTool = (id: string, purpose: string): ToolCallState => ({
    id,
    title: 'Bash ls',
    status: 'completed',
    kind: 'bash',
    inputJson: JSON.stringify({ __tool_use_purpose: purpose, command: 'ls' }),
    output: `${purpose} output`,
  });
  /** Laid-out height of every element (jsdom has no layout). */
  const layoutHeight = (px: number) => vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(px);
  afterEach(() => vi.restoreAllMocks());

  it.each(styles)('%s: a payload opens from 1px and closes from 1px under its height', (style) => {
    const { getByText, queryByText } = render(withStyle(style, <ToolCallGroup tools={[purposeTool('1', 'List the files')]} defaultExpanded />));
    expect(queryByText('List the files output')).toBeNull();
    fireEvent.click(getByText('List the files'));
    const payload = getByText('List the files output').closest('[data-reveal="disclosure"]') as HTMLElement;
    expect(payload.style.height).toBe('1px');

    layoutHeight(40);
    fireEvent.click(getByText('List the files'));
    expect(payload.style.height).toBe('39px');
  });

  it.each(styles)('%s: a group body opens from 1px and closes from 1px under its height', (style) => {
    const tools = [purposeTool('1', 'List the files'), purposeTool('2', 'Count the files')];
    const { container, getByText } = render(withStyle(style, <ToolCallGroup tools={tools} defaultExpanded={false} />));
    const header = container.querySelector('button[data-toolgroup-header]') as HTMLElement;
    fireEvent.click(header);
    const body = getByText('List the files').closest('[data-reveal="group"]') as HTMLElement;
    expect(body.style.height).toBe('1px');

    layoutHeight(120);
    fireEvent.click(header);
    expect(body.style.height).toBe('119px');
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
  it('does not auto-collapse after user manually toggles', () => {
    const running = [tool('1', 'Read a', 'running', 'read'), tool('2', 'Read b', 'running', 'read')];
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
    const done = [tool('1', 'Read a', 'completed', 'read'), tool('2', 'Read b', 'completed', 'read')];
    rerender(<ToolCallGroup tools={done} defaultExpanded={true} />);
    expect(getByText('Read a')).toBeTruthy();
  });

  it('a lone failed SubAgent without a roster says failed once', () => {
    const agent = { ...tool('agent-1', 'Agent', 'failed', 'agent'), detail: JSON.stringify({ subagent_type: 'Explore', description: 'Scan' }) };
    const { container } = render(<ToolCallGroup tools={[agent]} defaultExpanded={false} />);
    const header = container.querySelector('[data-toolgroup-header]');
    expect(header?.textContent).toMatch(/SubAgent · Explore/);
    expect(header?.textContent?.match(/failed/g)).toHaveLength(1);
  });

  it('failed group still auto-collapses (no exemption)', () => {
    const running = [tool('1', 'Read a', 'running', 'read'), tool('2', 'Read b', 'running', 'read')];
    const { rerender, getByText, queryByText } = render(
      <ToolCallGroup tools={running} defaultExpanded={true} />,
    );
    const failed = [tool('1', 'Read a', 'error', 'read'), tool('2', 'Read b', 'error', 'read')];
    rerender(<ToolCallGroup tools={failed} defaultExpanded={true} />);
    // Collapsed: header shows the ▸ marker and the expanded list is gone.
    expect(getByText('▸')).toBeTruthy();
    expect(queryByText('▾')).toBeNull();
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
    ...(partial.activity ? { activity: partial.activity } : {}),
  };
}

describe('ToolCallGroup — relayed-tool filter', () => {
  it('hides tools relayed as subagent activity, keeps the parent\'s own running tools', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const tools: ToolCallState[] = [
      { id: 't1', title: 'Agent', status: 'in_progress', kind: 'tool', detail },
      { id: 't2', title: 'Bash ls', status: 'running', kind: 'bash' },
      { id: 't3', title: 'Glob **/*.ts', status: 'running', kind: 'glob' },
      { id: 't4', title: 'Read src/index.ts', status: 'completed', kind: 'read' },
    ];
    const subagents = [subInfo({
      agentName: 'Explore',
      initialQuery: 'Explore Michi',
      activity: [{ id: 't2', kind: 'tool', title: 'Bash ls', status: 'in_progress' }],
    })];
    const { queryByText, getByText } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} subagents={subagents} />,
    );
    expect(queryByText('Bash ls')).toBeNull();
    expect(getByText(/Glob \*\*\/\*\.ts/)).toBeTruthy();
    expect(getByText(/Read src\/index\.ts/)).toBeTruthy();
    expect(getByText(/SubAgent · Explore/)).toBeTruthy();
  });

  it('keeps peers once every subagent has terminated (stale roster must not hide tools)', () => {
    const tools: ToolCallState[] = [
      { id: 't1', title: 'list_threads', status: 'completed', kind: 'tool' },
      { id: 't2', title: 'search_messages', status: 'completed', kind: 'tool' },
    ];
    const subagents = [
      subInfo({ sessionId: 's1', status: 'terminated' }),
      subInfo({ sessionId: 's2', status: 'terminated' }),
    ];
    const { getByText } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} subagents={subagents} />,
    );
    expect(getByText('list_threads')).toBeTruthy();
    expect(getByText('search_messages')).toBeTruthy();
  });
});

describe('ToolCallGroup — payload', () => {
  it('failed tool with output auto-opens its payload with stacked in/out labels', () => {
    const tools: ToolCallState[] = [{
      id: '1',
      title: 'Bash npm test',
      status: 'error',
      kind: 'bash',
      inputJson: '{"command":"npm test"}',
      output: 'FAIL exit 1',
    }];
    const { getByText, container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} />,
    );
    // Auto-opened: both hairline section labels and the output are visible.
    expect(getByText('in')).toBeTruthy();
    expect(getByText('out')).toBeTruthy();
    expect(container.textContent).toContain('FAIL exit 1');
  });

  it('completed tool payload stays closed until the row is clicked', () => {
    const tools: ToolCallState[] = [{
      id: '1',
      title: 'Bash ls',
      status: 'completed',
      kind: 'bash',
      output: 'file-a file-b',
    }];
    const { queryByText, getByText, container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} />,
    );
    expect(queryByText('out')).toBeNull();
    // The row (not the group header) toggles the payload.
    const rowTitle = getByText('Bash ls');
    fireEvent.click(rowTitle);
    expect(getByText('out')).toBeTruthy();
    expect(container.textContent).toContain('file-a file-b');
  });
});

describe('ToolCallGroup — SubAgent spine now line', () => {
  it('shows now ❯ <currentTool> when running and currentTool is non-empty', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const tools = [tool('1', 'Agent', 'in_progress', 'tool')];
    tools[0].detail = detail;
    const subagents = [
      subInfo({ agentName: 'Explore', initialQuery: 'Explore Michi', currentTool: 'Glob' }),
    ];

    const { container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} subagents={subagents} />,
    );
    expect(container.textContent).toContain('now ❯ Glob');
  });

  it('omits the now line when the chip is in a terminal status', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const tools = [tool('1', 'Agent', 'completed', 'tool')];
    tools[0].detail = detail;
    const subagents = [
      subInfo({ agentName: 'Explore', initialQuery: 'Explore Michi', currentTool: 'Glob' }),
    ];

    const { container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} subagents={subagents} />,
    );
    expect(container.textContent).not.toContain('now ❯');
  });

  it('omits the now line when currentTool is undefined', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const tools = [tool('1', 'Agent', 'in_progress', 'tool')];
    tools[0].detail = detail;
    const subagents = [
      subInfo({ agentName: 'Explore', initialQuery: 'Explore Michi' /* no currentTool */ }),
    ];

    const { container } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} subagents={subagents} />,
    );
    expect(container.textContent).not.toContain('now ❯');
  });
});

describe('ToolCallGroup — permission-enriched title', () => {
  it('renders a Cursor MCP title as the short tool name', () => {
    const tools = [tool('1', 'michi-list_threads: list_threads', 'pending', 'other')];
    const { getByText, queryByText } = render(
      <ToolCallGroup tools={tools} defaultExpanded={true} />,
    );
    expect(getByText('list_threads')).toBeTruthy();
    expect(queryByText('michi-list_threads: list_threads')).toBeNull();
  });
});
