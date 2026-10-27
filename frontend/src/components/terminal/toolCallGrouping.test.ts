import { describe, expect, it } from 'vitest';
import { extractToolUsePurpose } from 'michi-shared';
import { isRunningStatus, prettifyToolTitle, toolDisplayTitle, toolRowDetail } from './toolCallGrouping';
import type { ToolCallState } from '../../state/chatTypes';

describe('status predicates', () => {
  it('isRunningStatus: running/in_progress/pending/empty are running', () => {
    expect(isRunningStatus('running')).toBe(true);
    expect(isRunningStatus('in_progress')).toBe(true);
    expect(isRunningStatus('pending')).toBe(true);
    expect(isRunningStatus('')).toBe(true);
    expect(isRunningStatus(undefined)).toBe(true);
  });
});

// `partsToGroups` was deleted in step 5: parts/pendingParts are gone, and
// adjacent-tool grouping moved into `weaveToolCalls` in streamingProjection.ts
// (covered by streamingProjection.test.ts).

import { summarizeTools, summarizeToolsBase } from './toolCallGrouping';

function t(id: string, title: string, kind: string | undefined, status = 'completed'): ToolCallState {
  return { id, title, status, kind };
}

describe('summarizeTools', () => {
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

  it('single SubAgent — failed status renders the failed label', () => {
    const detail = JSON.stringify({
      description: 'Explore Michi project structure',
      subagent_type: 'Explore',
    });
    expect(
      summarizeTools([{ id: '1', title: 'Agent', status: 'error', kind: 'tool', detail }]),
    ).toBe('SubAgent · Explore · failed');
  });

  it('a lone SubAgent takes a given status word; other summaries ignore it', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', run_in_background: true });
    const agent: ToolCallState = { id: '1', title: 'Agent', status: 'completed', kind: 'tool', detail };
    expect(summarizeToolsBase([agent], 'in background')).toBe('SubAgent · Explore · in background');
    expect(summarizeToolsBase([agent])).toBe('SubAgent · Explore · completed');
    expect(summarizeToolsBase([agent, { ...agent, id: '2' }], 'in background')).toBe('2 SubAgents · completed');
    expect(summarizeToolsBase([t('r', 'Read package.json', 'read')], 'stopped')).toBe('Read package.json');
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
    ...(partial.activity ? { activity: partial.activity } : {}),
  };
}

describe('subagentTitleMatches', () => {
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

import { findOwningSubagent } from './toolCallGrouping';

function bashTool(id: string, status = 'completed'): ToolCallState {
  return { id, title: `Bash cmd-${id}`, status, kind: 'bash' };
}

describe('findOwningSubagent', () => {
  it('returns undefined for a Bash tool-call', () => {
    const subagents = [sub({})];
    expect(findOwningSubagent(bashTool('t1'), subagents)).toBeUndefined();
  });
});

import { filterSubagentRelayedTools } from './toolCallGrouping';

function subagentTool(
  id: string,
  agentType = 'Explore',
  description = 'Explore Michi project structure',
  status = 'in_progress',
): ToolCallState {
  const detail = JSON.stringify({ subagent_type: agentType, description });
  return { id, title: 'Agent', status, kind: 'tool', detail };
}

describe('filterSubagentRelayedTools', () => {
  it('removes only tools a subagent reported as its own activity', () => {
    const subagents = [sub({
      agentName: 'Explore',
      activity: [{ id: 't2', kind: 'tool', title: 'Bash ls', status: 'in_progress' }],
    })];
    const tools: ToolCallState[] = [
      subagentTool('t1'),
      bashTool('t2', 'running'),
      { id: 't3', title: 'Glob *.ts', status: 'running', kind: 'glob' },
      { id: 't4', title: 'Read package.json', status: 'completed', kind: 'read' },
    ];
    const result = filterSubagentRelayedTools(tools, subagents);
    // SubAgent card kept, relayed bash hidden, the parent's own glob (still
    // running alongside the subagent) and read kept.
    expect(result.map((t) => t.id)).toEqual(['t1', 't3', 't4']);
  });

  it('keeps the parent\'s running tools while a subagent works without relayed activity', () => {
    const subagents = [sub({ agentName: 'Explore' })];
    const tools = [subagentTool('t1'), bashTool('t2', 'running')];
    expect(filterSubagentRelayedTools(tools, subagents).map((t) => t.id)).toEqual(['t1', 't2']);
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

describe('prettifyToolTitle', () => {
  it('leaves a malformed mcp name (no tool segment) untouched', () => {
    expect(prettifyToolTitle('mcp__michi-tools')).toBe('mcp__michi-tools');
  });
});

describe('toolDisplayTitle — Kiro ask_user lifecycle', () => {
  it.each([
    ['', 'Running'],
    ['pending', 'Running'],
    ['in_progress', 'Running'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['error', 'Failed'],
    ['interrupted', 'Interrupted'],
    ['cancelled', 'Interrupted'],
    ['canceled', 'Interrupted'],
    ['custom-status', 'Running'],
  ])('displays %s with the matching known label', (status, prefix) => {
    const raw = Object.freeze({ id: 'ask-1', title: 'Running: @michi/ask_user', status });
    expect(toolDisplayTitle(raw)).toBe(`${prefix}: @michi/ask_user`);
    expect(raw.title).toBe('Running: @michi/ask_user');
  });

  it('preserves arbitrary MCP and model titles, including similarly named tools', () => {
    for (const title of [
      'Running: @other/ask_user', 'Running: @michi/custom_tool',
      'Running: @michi/ask_user extra', 'The model says Running: @michi/ask_user',
      'Running: inspect model output', '@michi/ask_user',
    ]) {
      expect(toolDisplayTitle({ id: 'other', title, status: 'completed' })).toBe(title);
    }
    expect(toolDisplayTitle({ id: 'mcp', title: 'mcp__other__custom_tool', status: 'completed' })).toBe('custom_tool');
  });

  it('uses the same display label in the single-tool summary', () => {
    expect(summarizeTools([{ id: 'ask-1', title: 'Running: @michi/ask_user', status: 'completed' }])).toBe('Completed: @michi/ask_user');
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

describe('extractToolUsePurpose', () => {
  it('reads the field from an object, a JSON string, and a truncated JSON string', () => {
    const obj = { __tool_use_purpose: 'Inspect workspace root', path: '/tmp' };
    expect(extractToolUsePurpose(obj)).toBe('Inspect workspace root');
    expect(extractToolUsePurpose(JSON.stringify(obj))).toBe('Inspect workspace root');
    expect(extractToolUsePurpose('{"__tool_use_purpose":"Inspect workspace root","path":"/tm')).toBe(
      'Inspect workspace root',
    );
  });

  it('returns undefined for commands, paths, and result dumps', () => {
    expect(extractToolUsePurpose({ command: 'npm test' })).toBeUndefined();
    expect(extractToolUsePurpose({ file_path: '/tmp/a.ts' })).toBeUndefined();
    expect(extractToolUsePurpose('{"data":"file contents"}')).toBeUndefined();
  });
});

describe('toolRowDetail — Kiro operations', () => {
  it('uses a path-like detail as the row argument when inputJson is missing', () => {
    expect(
      toolRowDetail({
        id: '1',
        title: 'Read',
        status: 'completed',
        kind: 'read',
        detail: '/workspace/example-app/package.json',
      }),
    ).toBe('/workspace/example-app/package.json');
  });
});

import { summarizeWork } from './toolCallGrouping';

describe('summarizeWork — agent block header', () => {
  it('leads with changes, then commands, then lookups, regardless of stream order', () => {
    expect(
      summarizeWork([
        t('1', 'Read a', 'read'),
        t('2', 'Read b', 'read'),
        t('3', 'Bash x', 'bash'),
        t('4', 'Edit c', 'edit'),
      ]),
    ).toEqual({ text: 'Edited 1 file, ran 1 command, read 2 files', failed: 0 });
  });

  it('caps the phrase list and counts the remaining tools', () => {
    expect(
      summarizeWork([
        t('1', 'Read a', 'read'),
        t('2', 'Glob *', 'glob'),
        t('3', 'Grep x', 'grep'),
        t('4', 'Bash x', 'bash'),
        t('5', 'Edit c', 'edit'),
        t('6', 'Read b', 'read'),
      ]).text,
    ).toBe('Edited 1 file, ran 1 command, searched 1 pattern, +3 more');
  });

  it('ignores hidden metadata tools in phrases and failure counts', () => {
    expect(
      summarizeWork([
        t('1', 'Read a', 'read'),
        t('2', 'set_branch_overview', undefined, 'error'),
      ]),
    ).toEqual({ text: 'Read 1 file', failed: 0 });
  });

  it('counts failures among visible tools', () => {
    expect(
      summarizeWork([t('1', 'Bash a', 'bash', 'error'), t('2', 'Bash b', 'bash')]),
    ).toEqual({ text: 'Ran 2 commands', failed: 1 });
  });

  it('names a lone unrecognized tool instead of saying "used 1 tool"', () => {
    expect(
      summarizeWork([{ id: '1', title: 'mcp__michi-tools__list_threads', status: 'completed', kind: 'tool' }]).text,
    ).toBe('list_threads');
  });

  it('gives SubAgents their own phrase in a mixed run', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Look around' });
    expect(
      summarizeWork([
        t('1', 'Read a', 'read'),
        { id: '2', title: 'Agent', status: 'completed', kind: 'tool', detail },
      ]).text,
    ).toBe('Ran 1 SubAgent, read 1 file');
  });

  it('returns empty text when no visible tools remain', () => {
    expect(summarizeWork([t('1', 'set_title', undefined)])).toEqual({ text: '', failed: 0 });
  });
});
