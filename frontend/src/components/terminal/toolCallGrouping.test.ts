import { describe, expect, it } from 'vitest';
import { extractToolUsePurpose } from 'michi-shared';
import {
  isRunningStatus,
  isTerminalStatus,
  isFailedStatus,
  isHiddenInternalTool,
  subagentToolInfo,
  prettifyToolTitle,
  toolPurpose,
  toolRowDetail,
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
  it('removes still-running non-SubAgent tools when ANY subagent is active, but keeps completed ones', () => {
    const subagents = [sub({ agentName: 'Explore' })];
    const tools: ToolCallState[] = [
      subagentTool('t1'),
      bashTool('t2', 'running'),
      { id: 't3', title: 'Glob *.ts', status: 'completed', kind: 'glob' },
      { id: 't4', title: 'Read package.json', status: 'completed', kind: 'read' },
    ];
    const result = filterSubagentRelayedTools(tools, subagents);
    // SubAgent card kept, running bash hidden, completed glob+read kept
    expect(result.map((t) => t.id)).toEqual(['t1', 't3', 't4']);
  });

  it('keeps non-SubAgent tools when subagents is empty', () => {
    const tools = [bashTool('t1'), bashTool('t2')];
    expect(filterSubagentRelayedTools(tools, []).map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('always keeps SubAgent tools regardless of subagents arg', () => {
    const tools = [subagentTool('t1'), subagentTool('t2', 'Planner', 'Plan')];
    expect(filterSubagentRelayedTools(tools, []).length).toBe(2);
    expect(filterSubagentRelayedTools(tools, undefined).length).toBe(2);
  });
});

describe('subagentToolInfo', () => {
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

describe('toolPurpose', () => {
  const kiroReadInput = {
    __tool_use_purpose: 'Check the project manifest to understand the package definition',
    operations: [{ mode: 'Line', path: '/workspace/example-app/package.json' }],
  };

  it('prefers __tool_use_purpose over a path-like detail (Kiro completion overwrite)', () => {
    expect(
      toolPurpose({
        id: '1',
        title: 'Read',
        status: 'completed',
        kind: 'read',
        detail: '/workspace/example-app/package.json',
        inputJson: JSON.stringify(kiroReadInput),
      }),
    ).toBe('Check the project manifest to understand the package definition');
  });

  it('does not treat a human detail string as purpose without __tool_use_purpose', () => {
    expect(
      toolPurpose({
        id: '1',
        title: 'Bash',
        status: 'completed',
        kind: 'bash',
        detail: 'Check git status after rebase',
      }),
    ).toBeUndefined();
  });

  it('does not treat Codex/Claude command dumps or stdout in detail as purpose', () => {
    expect(
      toolPurpose({
        id: '1',
        title: 'Shell',
        status: 'in_progress',
        kind: 'bash',
        detail: 'head -n 5 package.json',
        inputJson: JSON.stringify({ type: 'commandExecution', command: 'head -n 5 package.json' }),
      }),
    ).toBeUndefined();
    expect(
      toolPurpose({
        id: '2',
        title: 'bash',
        status: 'completed',
        kind: 'tool',
        detail: '{"cmd":"ls"}',
        inputJson: JSON.stringify({ cmd: 'ls' }),
      }),
    ).toBeUndefined();
  });

  it('finds a nested __tool_use_purpose under arguments', () => {
    expect(
      toolPurpose({
        id: '1',
        title: 'Read',
        status: 'completed',
        inputJson: JSON.stringify({
          arguments: {
            __tool_use_purpose: 'Inspect workspace root',
            path: '/workspace/example-app',
          },
        }),
      }),
    ).toBe('Inspect workspace root');
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
  it('pulls the path out of an operations array', () => {
    expect(
      toolRowDetail({
        id: '1',
        title: 'Read',
        status: 'completed',
        kind: 'read',
        inputJson: JSON.stringify({
          __tool_use_purpose: 'Check the Config file',
          operations: [{ mode: 'Line', path: '/workspace/example-app/package.json' }],
        }),
      }),
    ).toBe('/workspace/example-app/package.json');
  });

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
