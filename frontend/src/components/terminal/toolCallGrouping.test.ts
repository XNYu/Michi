import { describe, expect, it } from 'vitest';
import {
  isRunningStatus,
  isTerminalStatus,
  isFailedStatus,
  isHiddenInternalTool,
  subagentToolInfo,
  prettifyToolTitle,
} from './toolCallGrouping';
import type { ToolCallState } from '../../state/chatTypes';

describe('status predicates', () => {
  it('isRunningStatus: running/in_progress/pending/empty are running', () => {
    expect(isRunningStatus('running')).toBe(true);
    expect(isRunningStatus('in_progress')).toBe(true);
    expect(isRunningStatus('pending')).toBe(true);
    expect(isRunningStatus('')).toBe(true);
    expect(isRunningStatus(undefined)).toBe(true);
  });

  it('isRunningStatus: success/completed/error/failed are not running', () => {
    expect(isRunningStatus('success')).toBe(false);
    expect(isRunningStatus('completed')).toBe(false);
    expect(isRunningStatus('error')).toBe(false);
    expect(isRunningStatus('failed')).toBe(false);
  });

  it('isTerminalStatus: inverse of isRunningStatus', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('error')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
  });

  it('isFailedStatus: only error and failed', () => {
    expect(isFailedStatus('error')).toBe(true);
    expect(isFailedStatus('failed')).toBe(true);
    expect(isFailedStatus('completed')).toBe(false);
    expect(isFailedStatus('success')).toBe(false);
  });
});

describe('internal metadata tool visibility', () => {
  it('hides Codex App Server namespace titles', () => {
    expect(isHiddenInternalTool('michi_internal____set_branch_overview')).toBe(true);
    expect(isHiddenInternalTool('mcp____michi_internal____set_follow_ups')).toBe(true);
  });

  it('does not hide similarly named user tools without a namespace separator', () => {
    expect(isHiddenInternalTool('reset_branch_overview')).toBe(false);
  });
});

// `partsToGroups` was deleted in step 5: parts/pendingParts are gone, and
// adjacent-tool grouping moved into `weaveToolCalls` in streamingProjection.ts
// (covered by streamingProjection.test.ts).

import { summarizeTools } from './toolCallGrouping';

function t(id: string, title: string, kind: string | undefined, status = 'completed'): ToolCallState {
  return { id, title, status, kind };
}

describe('summarizeTools', () => {
  it('single tool returns the tool title verbatim', () => {
    expect(summarizeTools([t('1', 'Read package.json', 'read')])).toBe(
      'Read package.json',
    );
  });

  it('single tool: failure shows trailing failed marker', () => {
    expect(
      summarizeTools([t('1', 'Read x', 'read', 'error')]),
    ).toBe('Read x · failed');
  });

  it('multiple of the same kind: pluralizes the bucket', () => {
    expect(
      summarizeTools([
        t('1', 'Read a', 'read'),
        t('2', 'Read b', 'read'),
        t('3', 'Read c', 'read'),
      ]),
    ).toBe('read 3 files');
  });

  it('multiple kinds: comma-joined bucket phrases', () => {
    expect(
      summarizeTools([
        t('1', 'Read a', 'read'),
        t('2', 'Read b', 'read'),
        t('3', 'Bash npm test', 'bash'),
      ]),
    ).toBe('read 2 files, ran 1 command');
  });

  it('unknown kind falls back to generic phrasing', () => {
    expect(
      summarizeTools([
        t('1', 'Mystery 1', 'mystery'),
        t('2', 'Mystery 2', 'mystery'),
      ]),
    ).toBe('used 2 tools');
  });

  it('mixed: one failed appends · 1 failed', () => {
    expect(
      summarizeTools([
        t('1', 'Read a', 'read', 'completed'),
        t('2', 'Read b', 'read', 'error'),
        t('3', 'Bash x', 'bash', 'completed'),
      ]),
    ).toBe('read 2 files, ran 1 command · 1 failed');
  });

  it('no kind, no title falls back to generic', () => {
    expect(
      summarizeTools([
        { id: '1', title: '', status: 'completed' },
        { id: '2', title: '', status: 'completed' },
      ]),
    ).toBe('used 2 tools');
  });

  it('summarizes Claude Agent tool calls as SubAgent work', () => {
    const detail = JSON.stringify({
      description: 'Explore Michi project structure',
      subagent_type: 'Explore',
      model: 'haiku',
      prompt: 'I need to understand the core philosophy.',
    });

    expect(
      summarizeTools([{ id: '1', title: 'Agent', status: 'in_progress', kind: 'tool', detail }]),
    ).toBe('SubAgent · Explore · working');
  });

  it('single SubAgent — completed status renders the completed label', () => {
    const detail = JSON.stringify({
      description: 'Explore Michi project structure',
      subagent_type: 'Explore',
      model: 'haiku',
    });
    expect(
      summarizeTools([{ id: '1', title: 'Agent', status: 'completed', kind: 'tool', detail }]),
    ).toBe('SubAgent · Explore · completed');
  });

  it('single SubAgent — failed status renders the failed label', () => {
    const detail = JSON.stringify({
      description: 'Explore Michi project structure',
      subagent_type: 'Explore',
    });
    expect(
      summarizeTools([{ id: '1', title: 'Agent', status: 'error', kind: 'tool', detail }]),
    ).toBe('SubAgent · Explore · failed');
  });
});

import { subagentTitleMatches } from './toolCallGrouping';
import type { SubagentInfo } from '../../state/chatTypes';

function sub(partial: Partial<SubagentInfo>): SubagentInfo {
  return {
    sessionId: partial.sessionId ?? 'sub-1',
    sessionName: partial.sessionName ?? 'sub-1',
    agentName: partial.agentName ?? 'Explore',
    initialQuery: partial.initialQuery ?? 'Explore Michi project structure',
    status: partial.status ?? 'working',
    group: partial.group ?? 'default',
    dependsOn: partial.dependsOn ?? [],
    currentTool: partial.currentTool,
    statusMessage: partial.statusMessage,
  };
}

describe('subagentTitleMatches', () => {
  it('matches when agentType + description align with the subagent', () => {
    const detail = JSON.stringify({
      subagent_type: 'Explore',
      description: 'Explore Michi project structure',
    });
    const tool = { id: 't1', title: 'Agent', status: 'in_progress', kind: 'tool', detail };
    expect(subagentTitleMatches(tool, sub({}))).toBe(true);
  });

  it('matches when only the prompt overlaps the subagent.initialQuery', () => {
    const detail = JSON.stringify({
      subagent_type: 'Explore',
      prompt: 'Explore Michi project structure',
    });
    const tool = { id: 't1', title: 'Agent', status: 'in_progress', kind: 'tool', detail };
    expect(subagentTitleMatches(tool, sub({}))).toBe(true);
  });

  it('does not match a non-subagent tool', () => {
    const tool = { id: 't1', title: 'Bash', status: 'completed', kind: 'bash' };
    expect(subagentTitleMatches(tool, sub({}))).toBe(false);
  });

  it('does not match when agentType differs and no text overlap', () => {
    const detail = JSON.stringify({ subagent_type: 'Planner', description: 'Build a roadmap' });
    const tool = { id: 't1', title: 'Agent', status: 'in_progress', kind: 'tool', detail };
    expect(
      subagentTitleMatches(tool, sub({ agentName: 'Explore', initialQuery: 'something else' })),
    ).toBe(false);
  });
});

import { findOwningSubagent, filterSubagentRelayedTools } from './toolCallGrouping';

function bashTool(id: string, status = 'completed'): ToolCallState {
  return { id, title: `Bash cmd-${id}`, status, kind: 'bash' };
}
function subagentTool(
  id: string,
  agentType = 'Explore',
  description = 'Explore Michi project structure',
  status = 'in_progress',
): ToolCallState {
  const detail = JSON.stringify({ subagent_type: agentType, description });
  return { id, title: 'Agent', status, kind: 'tool', detail };
}

describe('findOwningSubagent', () => {
  it('returns the matching subagent for a SubAgent tool-call', () => {
    const subagents = [sub({ sessionId: 's1', agentName: 'Explore' })];
    const tool = subagentTool('t1');
    expect(findOwningSubagent(tool, subagents)?.sessionId).toBe('s1');
  });

  it('returns undefined for a Bash tool-call', () => {
    const subagents = [sub({})];
    expect(findOwningSubagent(bashTool('t1'), subagents)).toBeUndefined();
  });

  it('returns undefined when no subagent matches', () => {
    const subagents = [sub({ agentName: 'Planner', initialQuery: 'Plan something' })];
    expect(findOwningSubagent(subagentTool('t1', 'Explore'), subagents)).toBeUndefined();
  });
});

describe('filterSubagentRelayedTools', () => {
  it('removes non-SubAgent tools (Bash, Glob, Read) when ANY subagent is active', () => {
    const subagents = [sub({ agentName: 'Explore' })];
    const tools: ToolCallState[] = [
      subagentTool('t1'),
      bashTool('t2'),
      { id: 't3', title: 'Glob *.ts', status: 'completed', kind: 'glob' },
      { id: 't4', title: 'Read package.json', status: 'completed', kind: 'read' },
    ];
    const result = filterSubagentRelayedTools(tools, subagents);
    expect(result.map((t) => t.id)).toEqual(['t1']);
  });

  it('keeps non-SubAgent tools when subagents is empty', () => {
    const tools = [bashTool('t1'), bashTool('t2')];
    expect(filterSubagentRelayedTools(tools, []).map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('keeps non-SubAgent tools when subagents is undefined', () => {
    const tools = [bashTool('t1')];
    expect(filterSubagentRelayedTools(tools, undefined).map((t) => t.id)).toEqual(['t1']);
  });

  it('always keeps SubAgent tools regardless of subagents arg', () => {
    const tools = [subagentTool('t1'), subagentTool('t2', 'Planner', 'Plan')];
    expect(filterSubagentRelayedTools(tools, []).length).toBe(2);
    expect(filterSubagentRelayedTools(tools, undefined).length).toBe(2);
  });
});

describe('subagentToolInfo', () => {
  it('extracts useful fields from an Agent detail payload', () => {
    const detail = JSON.stringify({
      description: 'Explore Michi project structure',
      subagent_type: 'Explore',
      model: 'haiku',
      prompt: 'I need to understand the core philosophy.',
    });

    expect(
      subagentToolInfo({ id: '1', title: 'Agent', status: 'in_progress', kind: 'tool', detail }),
    ).toEqual({
      agentType: 'Explore',
      description: 'Explore Michi project structure',
      prompt: 'I need to understand the core philosophy.',
      model: 'haiku',
    });
  });

  it('still recognizes truncated JSON-like Agent detail strings', () => {
    const detail = '{"description":"Explore Michi project structure","subagent_type":"Explore","model":"haiku","prompt":"I need';

    expect(
      subagentToolInfo({ id: '1', title: 'Agent', status: 'in_progress', kind: 'tool', detail }),
    ).toMatchObject({
      agentType: 'Explore',
      description: 'Explore Michi project structure',
      model: 'haiku',
    });
  });

  it('does NOT classify an MCP tool as a subagent from its result content', () => {
    // A completed tool's `detail` is overwritten with its result content. MCP
    // tools return `[{"type":"text",...}]`; the bare `type` field must not be
    // mistaken for a subagent_type (regression: every MCP tool showed as
    // "SubAgent · Text").
    const detail = JSON.stringify([{ type: 'text', text: 'Found 5 matches across 2 threads.' }]);
    expect(
      subagentToolInfo({ id: '1', title: 'search_messages', status: 'completed', kind: 'tool', detail }),
    ).toBeNull();
  });

  it('does NOT classify a tool whose result JSON merely contains a type field', () => {
    const detail = JSON.stringify({ type: 'object', properties: {} });
    expect(
      subagentToolInfo({ id: '1', title: 'list_threads', status: 'completed', kind: 'tool', detail }),
    ).toBeNull();
  });
});

describe('prettifyToolTitle', () => {
  it('strips the mcp__<server>__ prefix and keeps the tool segment', () => {
    expect(prettifyToolTitle('mcp__michi-tools__list_threads')).toBe('list_threads');
    expect(prettifyToolTitle('mcp__michi-tools__search_messages')).toBe('search_messages');
  });

  it('preserves tool names that contain underscores', () => {
    expect(prettifyToolTitle('mcp__server__read_node')).toBe('read_node');
  });

  it('passes non-MCP titles through unchanged', () => {
    expect(prettifyToolTitle('Read package.json')).toBe('Read package.json');
    expect(prettifyToolTitle('Bash')).toBe('Bash');
    expect(prettifyToolTitle('')).toBe('');
  });

  it('leaves a malformed mcp name (no tool segment) untouched', () => {
    expect(prettifyToolTitle('mcp__michi-tools')).toBe('mcp__michi-tools');
  });

  it('strips Cursor ACP michi-<tool>: <tool> titles', () => {
    expect(prettifyToolTitle('michi-list_threads: list_threads')).toBe('list_threads');
    expect(prettifyToolTitle('michi-set_follow_ups: set_follow_ups')).toBe('set_follow_ups');
  });

  it('strips a bare michi- / michi__ prefix', () => {
    expect(prettifyToolTitle('michi-list_threads')).toBe('list_threads');
    expect(prettifyToolTitle('michi__list_threads')).toBe('list_threads');
  });
});

describe('summarizeTools — MCP tool (regression)', () => {
  it('renders a completed MCP tool by its prettified name, not as a SubAgent', () => {
    const detail = JSON.stringify([{ type: 'text', text: '40 threads.' }]);
    expect(
      summarizeTools([
        { id: '1', title: 'mcp__michi-tools__list_threads', status: 'completed', kind: 'tool', detail },
      ]),
    ).toBe('list_threads');
  });
});
