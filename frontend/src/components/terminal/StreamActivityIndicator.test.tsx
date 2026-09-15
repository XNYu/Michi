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
  it('returns null when not streaming', () => {
    expect(deriveStreamActivity(node({ status: 'idle' }))).toBeNull();
    expect(deriveStreamActivity(node({ status: 'error' }))).toBeNull();
  });

  it('returns null while hidden overview metadata finishes after visible completion', () => {
    const n = node({
      visibleResponseComplete: true,
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'answer', rawText: 'complete answer', streaming: false }],
      })],
    });
    expect(deriveStreamActivity(n)).toBeNull();
  });

  it('returns null for a brand-new empty turn (in-bubble dots own it)', () => {
    const n = node({ messages: [assistant({})] });
    expect(deriveStreamActivity(n)).toBeNull();
  });

  it('falls back to Working when the tail message is not an assistant', () => {
    const userMsg: ChatMessage = {
      id: 'u1', role: 'user', text: 'hi', toolCalls: [], createdAt: 0,
    };
    expect(deriveStreamActivity(node({ messages: [userMsg] }))?.label).toBe('Working');
  });

  it('returns null while a visible tool is running because its chip owns the status', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'answer', rawText: 'sure', streaming: false }],
        toolCalls: [tool('t1', 'bash', 'in_progress')],
      })],
    });
    expect(deriveStreamActivity(n)).toBeNull();
  });

  it('returns null for a running tool even while a thinking block streams', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'hmm', streaming: true }],
        toolCalls: [tool('t1', 'grep', 'running')],
      })],
    });
    expect(deriveStreamActivity(n)).toBeNull();
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

  it('stays quiet while visible answer text streams (cursor conveys liveness)', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'answer', rawText: 'partial', streaming: true }],
      })],
    });
    expect(deriveStreamActivity(n)).toBeNull();
  });

  it('shows Working when answer block is streaming but idle > 2s (e.g. file write)', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'answer', rawText: 'partial', streaming: true }],
      })],
    });
    (n as any).streamingIdleMs = 3000;
    expect(deriveStreamActivity(n)?.label).toBe('Working');
  });

  it('stays quiet when answer block is streaming and idle < 2s', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'answer', rawText: 'partial', streaming: true }],
      })],
    });
    (n as any).streamingIdleMs = 1500;
    expect(deriveStreamActivity(n)).toBeNull();
  });

  it('shows Thinking while a thinking block streams with no running tool', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'reasoning', streaming: true }],
      })],
    });
    expect(deriveStreamActivity(n)?.label).toBe('Thinking');
  });

  it('shows Working in a between-steps gap (blocks exist, nothing streaming)', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'done reasoning', streaming: false }],
        toolCalls: [tool('t1', 'bash', 'completed')],
      })],
    });
    expect(deriveStreamActivity(n)?.label).toBe('Working');
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

  it('still renders once all subagents have terminated', () => {
    const sub: SubagentInfo = {
      sessionId: 's1', sessionName: 'sub', agentName: 'explorer', initialQuery: 'q',
      status: 'terminated', group: '', dependsOn: [],
    };
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'x', streaming: true }],
      })],
      subagents: [sub],
    });
    expect(deriveStreamActivity(n)?.label).toBe('Thinking');
  });

  it('returns null for a running tool with a long title', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'answer', rawText: 'ok', streaming: false }],
        toolCalls: [tool('t1', 'x'.repeat(80), 'running')],
      })],
    });
    expect(deriveStreamActivity(n)).toBeNull();
  });
});

describe('deriveStreamActivity — Kiro plan steps', () => {
  it('surfaces the in-progress step with a 1-based "Step N/M" detail and content label', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'x', streaming: false }],
        plan: [
          planEntry('read the files', 'completed'),
          planEntry('parse tokens', 'in_progress'),
          planEntry('write output', 'pending'),
        ],
      })],
    });
    const a = deriveStreamActivity(n);
    expect(a?.detail).toBe('Step 2/3');
    expect(a?.label).toBe('parse tokens');
  });

  it('overrides the Thinking/Working fallback when a plan step is in progress', () => {
    // Tail thinking block is NOT streaming → without a plan this would be "Working".
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'x', streaming: false }],
        plan: [planEntry('do the thing', 'in_progress')],
      })],
    });
    expect(deriveStreamActivity(n)?.detail).toBe('Step 1/1');
  });

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

  it('stays quiet for plan progress while visible answer text streams', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'answer', rawText: 'partial', streaming: true }],
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

  it('falls back to Working when the in-progress entry has empty content', () => {
    const n = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'x', streaming: false }],
        plan: [planEntry('   ', 'in_progress')],
      })],
    });
    const a = deriveStreamActivity(n);
    expect(a?.detail).toBe('Step 1/1');
    expect(a?.label).toBe('Working');
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

  it('renders nothing when there is no standalone activity', () => {
    const { container } = render(
      <StreamActivityIndicator node={node({ status: 'idle' })} />,
    );
    expect(container.firstChild).toBeNull();
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

  it('does not run a 1Hz elapsed timer while the node is not streaming', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    // An idle node produces no activity; the elapsed ticker must not run.
    render(<StreamActivityIndicator node={node({ status: 'idle' })} />);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('stops the elapsed timer once the node leaves the streaming state', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const streamingNode = node({
      messages: [assistant({
        blocks: [{ id: 'b0', kind: 'thinking', rawText: 'reasoning', streaming: true }],
      })],
    });
    const { rerender } = render(<StreamActivityIndicator node={streamingNode} />);
    // Flip to idle — the interval effect must tear its timer down.
    rerender(<StreamActivityIndicator node={{ ...streamingNode, status: 'idle' }} />);
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
