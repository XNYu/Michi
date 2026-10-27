import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { StreamActivityIndicator, deriveStreamActivity } from './StreamActivityIndicator';
import type { AssistantBlock, ChatMessage, ChatNodeState, SubagentInfo, ToolCallState } from '../../state/chatTypes';
import type { PlanEntry } from '../../services/api';

function tool(id: string, title: string, status: string): ToolCallState {
  return { id, title, status };
}

function planEntry(content: string, status: PlanEntry['status']): PlanEntry {
  return { content, priority: 'medium', status };
}

function assistant(opts: {
  blocks?: AssistantBlock[];
  toolCalls?: ToolCallState[];
  text?: string;
  thought?: string;
  plan?: PlanEntry[];
  streaming?: boolean;
}): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    text: opts.text ?? '',
    thought: opts.thought,
    toolCalls: opts.toolCalls ?? [],
    blocks: opts.blocks,
    plan: opts.plan,
    streaming: opts.streaming ?? true,
    createdAt: 0,
  };
}

function node(opts: {
  status?: ChatNodeState['status'];
  messages?: ChatMessage[];
  subagents?: SubagentInfo[];
  visibleResponseComplete?: boolean;
}): ChatNodeState {
  return {
    nodeId: 'n1',
    kind: 'chat',
    chatId: 'c1',
    projectId: 'p1',
    messages: opts.messages ?? [],
    followUps: [],
    status: opts.status ?? 'streaming',
    subagents: opts.subagents,
    visibleResponseComplete: opts.visibleResponseComplete,
  };
}

describe('deriveStreamActivity', () => {
  it('shows native recovery before the first token, even when the assistant is empty', () => {
    const n = { ...node({ messages: [assistant({})] }), runtimeActivity: 'Restoring original Kiro session' };
    expect(deriveStreamActivity(n)?.label).toBe('Restoring original Kiro session');
    expect(deriveStreamActivity({ ...n, status: 'error' })).toBeNull();
  });

  it('returns null while a hidden internal tool is running (ThoughtCard shows Working)', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'done', streaming: false }],
        toolCalls: [
          tool('t1', 'bash', 'completed'),
          tool('t2', 'michi_internal____set_branch_overview', 'running'),
        ],
      })],
    });
    expect(deriveStreamActivity(n)).toBeNull();
  });

  it('defers to SubagentStatus while a Kiro subagent is working', () => {
    const sub: SubagentInfo = {
      sessionId: 's1', sessionName: 'sub', agentName: 'explorer', initialQuery: 'q',
      status: 'working', group: '', dependsOn: [],
    };
    const n = node({
      messages: [assistant({ toolCalls: [tool('t1', 'bash', 'running')] })],
      subagents: [sub],
    });
    expect(deriveStreamActivity(n)).toBeNull();
  });
});

describe('deriveStreamActivity — Kiro plan steps', () => {
  it('suppresses the plan row while a visible tool chip is running', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'answer', rawText: 'ok', streaming: false }],
        toolCalls: [tool('t1', 'bash', 'running')],
        plan: [planEntry('step one', 'in_progress')],
      })],
    });
    expect(deriveStreamActivity(n)).toBeNull();
  });

  it('ignores a plan with no in-progress entry (falls through to fallback)', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'x', streaming: true }],
        plan: [planEntry('done', 'completed'), planEntry('later', 'pending')],
      })],
    });
    const a = deriveStreamActivity(n);
    expect(a?.detail).toBeUndefined();
    expect(a?.label).toBe('Thinking');
  });
});

describe('deriveStreamActivity — live thought header', () => {
  const card = { showThoughts: true, agentBlockStyle: 'card' as const };
  const plain = { showThoughts: true, agentBlockStyle: 'plain' as const };
  const betweenSteps = () => node({
    messages: [assistant({
      blocks: [
        { id: 'b0', kind: 'thinking', rawText: 'done reasoning', streaming: false },
        { id: 'b1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 0 },
      ],
      toolCalls: [tool('t1', 'bash', 'completed')],
    })],
  });

  it('defers to the card header in a between-steps gap', () => {
    expect(deriveStreamActivity(betweenSteps(), card)).toBeNull();
  });

  it('keeps Working once answer prose ends the agent cluster', () => {
    const n = node({
      messages: [assistant({
        blocks: [
          { id: 'b0', kind: 'thinking', rawText: 'x', streaming: false },
          { id: 'b1', kind: 'answer', rawText: 'Here is the answer', streaming: false },
        ],
      })],
    });
    expect(deriveStreamActivity(n, card)?.label).toBe('Working');
  });
});

describe('StreamActivityIndicator (render)', () => {
  it('shows post-cancel cleanup on an idle node without a streaming elapsed timer', () => {
    const n = { ...node({ status: 'idle' }), runtimeActivity: 'Waiting for cancellation to finish', streamingStartedAt: Date.now() - 30_000 };
    const { getByRole, queryByText } = render(<StreamActivityIndicator node={n} />);
    expect(getByRole('status').getAttribute('aria-label')).toBe('Waiting for cancellation to finish');
    expect(queryByText('30s')).toBeNull();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the derived label and reveals an elapsed counter after the grace window', () => {
    vi.useFakeTimers();
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'reasoning', streaming: true }],
      })],
    });
    const { getByRole, queryByText } = render(<StreamActivityIndicator node={n} />);

    // Label shows immediately; elapsed counter is suppressed under the grace window.
    expect(getByRole('status').textContent).toContain('Thinking');
    expect(queryByText(/^\d+s$/)).toBeNull();

    // Past the 3s grace window the seconds counter appears.
    act(() => { vi.advanceTimersByTime(4000); });
    expect(queryByText(/^\d+s$/)).not.toBeNull();
  });

  it('renders the "Step N/M" detail chip alongside the plan step label', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'x', streaming: false }],
        plan: [
          planEntry('read the files', 'completed'),
          planEntry('parse tokens', 'in_progress'),
        ],
      })],
    });
    const { getByText, getByRole } = render(<StreamActivityIndicator node={n} />);
    expect(getByText('Step 2/2')).toBeTruthy();
    expect(getByText('parse tokens')).toBeTruthy();
    expect(getByRole('status').getAttribute('aria-label')).toContain('Step 2/2');
  });
});
