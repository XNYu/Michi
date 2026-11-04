// Turn trust classification (services/turnTrust.ts): each runtime's representative
// tool calls, from the runtime's own wire format through its adapter to the
// NormalizedEvent chatHub sees and the verdict on it.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createTranslator } from 'michi-runtime/internal/adapters/claude/claudeEventTranslator';
import { createCodexTranslator } from 'michi-runtime/internal/adapters/codex/codexEventTranslator';
import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import { KIRO_FLAVOR, type AcpAgentFlavor } from 'michi-runtime/internal/adapters/kiro/acpAgentFlavor';
import type { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { ANTIGRAVITY_KIRO_FLAVOR } from 'michi-runtime/internal/adapters/antigravity/antigravityFlavor';
import { createDefaultHost } from 'michi-runtime/internal/core/defaultHost';
import { interactiveOwner } from 'michi-runtime/internal/contract/types';
import { AGENT_RUN_TOOL_NAMES } from 'michi-runtime/internal/contract/tools';
import { mapAgentEvent, type MapperContext } from '../src/agents/pi/eventMapper';
import { BUILTIN_TOOLS } from '../src/agents/builtinTools';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { classifyToolTrust, MICHI_TOOL_NAMES, type ToolTrust } from '../src/services/turnTrust';

type ToolEvent = Extract<NormalizedEvent, { kind: 'tool_call' | 'tool_call_update' }>;

/** The verdict observeTurnTrust reaches for a tool event (see observedCall). */
function verdict(runtimeId: string, ev: NormalizedEvent | undefined): ToolTrust {
  assert.ok(ev && (ev.kind === 'tool_call' || ev.kind === 'tool_call_update'), `a tool event, got ${JSON.stringify(ev)}`);
  const tool = ev as ToolEvent;
  return classifyToolTrust({
    runtimeId,
    toolName: tool.toolName ?? '',
    mcpServer: tool.mcpServer ?? null,
    ...(tool.hostTool !== undefined ? { hostTool: tool.hostTool } : {}),
    kind: tool.kindType,
  });
}

describe('classifyToolTrust', () => {
  const cases: Array<[string, Parameters<typeof classifyToolTrust>[0], ToolTrust]> = [
    ['Michi web_search', { runtimeId: 'pi', toolName: 'web_search', hostTool: true }, 'untrusted'],
    ['Michi fetch_content', { runtimeId: 'pi', toolName: 'fetch_content', hostTool: true }, 'untrusted'],
    ['Michi web_search over MCP', { runtimeId: 'claude', toolName: 'web_search', mcpServer: '__michi_internal__', hostTool: true }, 'untrusted'],
    ['Pi bash', { runtimeId: 'pi', toolName: 'bash', hostTool: true }, 'untrusted'],
    ['a Michi tool', { runtimeId: 'codex', toolName: 'read_node', mcpServer: '__michi_internal__', hostTool: true }, 'trusted'],
    ['a new Michi tool', { runtimeId: 'pi', toolName: 'memory_save', hostTool: true }, 'trusted'],
    ['another MCP server', { runtimeId: 'claude', toolName: 'read', mcpServer: 'filesystem', hostTool: false }, 'untrusted'],
    ['an MCP server named michi that is not Michi', { runtimeId: 'claude', toolName: 'x', mcpServer: 'michi', hostTool: false }, 'untrusted'],
    ['Michi server by name only', { runtimeId: 'kiro', toolName: 'list_threads', mcpServer: 'michi' }, 'trusted'],
    ['raw Claude MCP name', { runtimeId: 'claude', toolName: 'mcp__github__get_issue' }, 'untrusted'],
    ['raw Claude Michi name', { runtimeId: 'claude', toolName: 'mcp____michi_internal____set_follow_ups' }, 'trusted'],
    ['raw Kiro MCP name', { runtimeId: 'kiro', toolName: '@github/create_issue' }, 'untrusted'],
    ['raw Kiro Michi name', { runtimeId: 'kiro', toolName: '@michi/send_to_thread' }, 'trusted'],
    ['raw agy MCP name', { runtimeId: 'antigravity', toolName: 'mcp_github_search' }, 'untrusted'],
    ['raw agy Michi name', { runtimeId: 'antigravity', toolName: 'mcp_michi_ask_user' }, 'trusted'],
    ['bare Michi name', { runtimeId: 'kiro', toolName: 'set_branch_overview' }, 'trusted'],
    ['workspace read', { runtimeId: 'claude', toolName: 'Read' }, 'trusted'],
    ['unknown tool', { runtimeId: 'claude', toolName: 'TeleportFile' }, 'untrusted'],
    ["unknown tool, a runtime's own kind", { runtimeId: 'claude', toolName: 'TeleportFile', kind: 'tool' }, 'untrusted'],
    ['unknown tool the agent calls a workspace read', { runtimeId: 'kiro', toolName: 'code', kind: 'read' }, 'trusted'],
    ['unknown tool the agent calls a fetch', { runtimeId: 'kiro', toolName: 'browse_page', kind: 'fetch' }, 'untrusted'],
    ['an MCP tool the agent calls a read', { runtimeId: 'kiro', toolName: 'get_issue', mcpServer: 'jira', hostTool: false, kind: 'read' }, 'untrusted'],
    ['no name, read kind', { runtimeId: 'kiro', toolName: '', kind: 'read' }, 'trusted'],
    ['no name, search kind', { runtimeId: 'kiro', toolName: '', kind: 'search' }, 'trusted'],
    ['no name, fetch kind', { runtimeId: 'kiro', toolName: '', kind: 'fetch' }, 'untrusted'],
    ['no name, execute kind', { runtimeId: 'kiro', toolName: '', kind: 'execute' }, 'untrusted'],
    ['no name, other kind', { runtimeId: 'kiro', toolName: '', kind: 'other' }, 'untrusted'],
    ['no name, no kind', { runtimeId: 'kiro', toolName: '' }, 'untrusted'],
  ];
  for (const [label, input, expected] of cases) {
    test(label, () => assert.equal(classifyToolTrust(input), expected));
  }

  test("every Michi tool is judged by its bare name: trusted, but web, fetch and shell", () => {
    const untrusted = new Set(['web_search', 'fetch_content', 'bash']);
    const names = [...BUILTIN_TOOLS.map((tool) => tool.name), ...AGENT_RUN_TOOL_NAMES];
    for (const name of names) {
      assert.equal(classifyToolTrust({ runtimeId: 'kiro', toolName: name }), untrusted.has(name) ? 'untrusted' : 'trusted',
        `${name}: add it to MICHI_TOOL_NAMES, or to UNTRUSTED_TOOL_NAMES if it returns outside content`);
    }
    for (const name of MICHI_TOOL_NAMES) assert.equal(classifyToolTrust({ runtimeId: 'kiro', toolName: name }), 'trusted', name);
  });
});

describe('Claude tool calls', () => {
  function toolCall(name: string): NormalizedEvent | undefined {
    const emitted: NormalizedEvent[] = [];
    const { feed } = createTranslator((ev) => emitted.push(ev));
    feed({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name } } });
    return emitted.find((ev) => ev.kind === 'tool_call');
  }

  const cases: Array<[string, ToolTrust]> = [
    ['WebFetch', 'untrusted'], ['WebSearch', 'untrusted'], ['Bash', 'untrusted'], ['BashOutput', 'untrusted'],
    ['mcp__github__get_issue', 'untrusted'], ['ReadMcpResourceTool', 'untrusted'], ['SomeFutureTool', 'untrusted'],
    ['Read', 'trusted'], ['Grep', 'trusted'], ['Glob', 'trusted'], ['Edit', 'trusted'], ['Write', 'trusted'],
    ['TodoWrite', 'trusted'], ['Task', 'trusted'], ['AskUserQuestion', 'trusted'],
    ['mcp____michi_internal____set_follow_ups', 'trusted'], ['mcp____michi_internal____read_node', 'trusted'],
  ];
  for (const [name, expected] of cases) {
    test(`${name} is ${expected}`, () => assert.equal(verdict('claude', toolCall(name)), expected));
  }

  test('an MCP call names its server; Michi\'s is the host', () => {
    assert.deepEqual(pick(toolCall('mcp__github__get_issue')), { toolName: 'get_issue', mcpServer: 'github', hostTool: false });
    assert.deepEqual(pick(toolCall('mcp____michi_internal____ask_user')), { toolName: 'ask_user', mcpServer: '__michi_internal__', hostTool: true });
    assert.deepEqual(pick(toolCall('Read')), { toolName: 'Read' });
  });

  test('the trailing assistant envelope names the tool too', () => {
    const emitted: NormalizedEvent[] = [];
    const { feed } = createTranslator((ev) => emitted.push(ev));
    feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'WebSearch', input: { query: 'x' } }] } });
    assert.equal(verdict('claude', emitted.find((ev) => ev.kind === 'tool_call')), 'untrusted');
  });
});

function pick(ev: NormalizedEvent | undefined): Record<string, unknown> {
  const tool = ev as ToolEvent;
  return Object.fromEntries(Object.entries({ toolName: tool.toolName, mcpServer: tool.mcpServer, hostTool: tool.hostTool })
    .filter(([, value]) => value !== undefined));
}

describe('codex tool calls', () => {
  function started(item: Record<string, unknown>): NormalizedEvent | undefined {
    const emitted: NormalizedEvent[] = [];
    const { feed, startTurn } = createCodexTranslator((ev) => emitted.push(ev));
    startTurn();
    feed('item/started', { item: { id: 'item_1', ...item } });
    return emitted.find((ev) => ev.kind === 'tool_call');
  }

  const command = (...types: string[]) => ({
    type: 'commandExecution', command: 'x', commandActions: types.map((type) => ({ type, command: 'x', path: 'a.ts', name: 'a.ts', query: 'q' })),
  });

  test('a shell command is untrusted', () => {
    assert.equal(verdict('codex', started(command('unknown'))), 'untrusted');
    assert.equal(verdict('codex', started({ type: 'commandExecution', command: 'curl https://example.com' })), 'untrusted');
    assert.equal(pick(started(command('unknown'))).toolName, 'shell');
  });

  test('a command codex parsed into workspace reads is a read', () => {
    assert.equal(verdict('codex', started(command('read'))), 'trusted');
    assert.equal(verdict('codex', started(command('listFiles'))), 'trusted');
    assert.equal(verdict('codex', started(command('search', 'read'))), 'trusted');
    assert.equal(verdict('codex', started(command('read', 'unknown'))), 'untrusted', 'one unparsed action makes it a shell command');
  });

  test('web search is untrusted, a patch is trusted', () => {
    assert.equal(verdict('codex', started({ type: 'webSearch', query: 'news' })), 'untrusted');
    assert.equal(verdict('codex', started({ type: 'fileChange', changes: [{ path: 'a.ts', kind: 'update' }] })), 'trusted');
  });

  test("MCP calls: Michi's server is trusted, any other is not", () => {
    const michi = started({ type: 'mcpToolCall', server: '__michi_internal__', tool: 'read_node', arguments: {} });
    assert.deepEqual(pick(michi), { toolName: 'read_node', mcpServer: '__michi_internal__', hostTool: true });
    assert.equal(verdict('codex', michi), 'trusted');
    assert.equal(verdict('codex', started({ type: 'mcpToolCall', server: 'github', tool: 'get_issue', arguments: {} })), 'untrusted');
  });

  test('the completed item names the tool too', () => {
    const emitted: NormalizedEvent[] = [];
    const { feed, startTurn } = createCodexTranslator((ev) => emitted.push(ev));
    startTurn();
    feed('item/completed', { item: { id: 'item_2', type: 'webSearch', query: 'news', status: 'completed' } });
    assert.equal(verdict('codex', emitted.find((ev) => ev.kind === 'tool_call_update')), 'untrusted');
  });
});

/** An ACP client stand-in whose prompt yields what the test pushes (see runtime/test/kiroStandardAcpFlavor.test.ts). */
function fakeClient() {
  const queue: Record<string, any>[] = [];
  let wake: (() => void) | null = null;
  const push = (update: Record<string, any>) => { queue.push(update); wake?.(); wake = null; };
  return {
    push,
    async *prompt() {
      for (;;) {
        while (queue.length) {
          const update = queue.shift()!;
          yield update;
          if (update.sessionUpdate === 'turn_end') return;
        }
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
    injectUpdate(_sid: string, update: Record<string, any>) { push(update); return true; },
    respondToPermission() {}, respondToPermissionKind() {}, cancelPermission() {},
  };
}

/** The tool events an ACP agent's updates become in AcpAgentSession. */
async function acpToolEvents(flavor: AcpAgentFlavor, standardAcp: boolean, updates: Record<string, any>[]): Promise<ToolEvent[]> {
  const client = fakeClient();
  const runtime = {
    host: createDefaultHost({ logLevel: 'silent' }), engine: 'v2', flavor, standardAcp,
    ensureClient: async () => client, getClient: () => client, getCurrentMode: () => null, getCurrentModel: () => null,
    respondToPermission: () => {}, cancelPermission: () => {},
  } as unknown as AcpAgentRuntime;
  const session = new AcpAgentSession('node', 'sid', runtime, '/w', { owner: interactiveOwner('node') });
  const events: NormalizedEvent[] = [];
  const done = (async () => { for await (const event of session.send('go')) events.push(event); })();
  for (const update of updates) client.push(update);
  client.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
  await Promise.race([done, delay(5_000).then(() => { throw new Error('turn did not end'); })]);
  return events.filter((ev): ev is ToolEvent => ev.kind === 'tool_call' || ev.kind === 'tool_call_update');
}

const acpCall = (toolCallId: string, fields: Record<string, any>) => ({ sessionUpdate: 'tool_call', toolCallId, status: 'pending', ...fields });

describe('Kiro tool calls', () => {
  test('names from _meta (v2 toolName, v3 toolId), titles and kinds', async () => {
    const events = await acpToolEvents(KIRO_FLAVOR, false, [
      acpCall('v2-shell', { title: 'Running: echo hi', kind: 'execute', _meta: { kiro: { toolName: 'execute_bash' } } }),
      acpCall('v2-read', { title: 'Reading a.ts', kind: 'read', _meta: { kiro: { toolName: 'fs_read' } } }),
      acpCall('v2-fetch', { title: 'Fetching a page', kind: 'fetch', _meta: { kiro: { toolName: 'web_fetch' } } }),
      acpCall('v2-search', { title: 'Searching the web', kind: 'search', _meta: { kiro: { toolName: 'web_search' } } }),
      acpCall('v3-shell', { title: 'ls', _meta: { kiro: { toolId: 'run_command' } } }),
      acpCall('v3-write', { title: 'Write File', _meta: { kiro: { toolId: 'fs_write' } } }),
      acpCall('michi', { title: '@michi/set_branch_overview', kind: 'other' }),
      acpCall('michi-bare', { title: 'set_follow_ups', kind: 'other' }),
      acpCall('external', { title: 'Using a tool', kind: 'other', _meta: { toolName: '@github/create_issue' } }),
      acpCall('external-v3', { title: 'x', _meta: { kiro: { toolId: 'jira::get_issue' } } }),
      acpCall('prose-read', { title: 'Read file', kind: 'read' }),
      acpCall('prose-grep', { title: 'grep', kind: 'search' }),
      acpCall('prose-other', { title: 'Doing something', kind: 'other' }),
      acpCall('file-title', { title: 'README.md', kind: 'read' }),
      // A later update without a name keeps the call's name (KiroToolCallNames).
      { sessionUpdate: 'tool_call_update', toolCallId: 'v2-shell', status: 'completed', rawOutput: 'hi' },
    ]);
    const byId = new Map(events.filter((ev) => ev.kind === 'tool_call').map((ev) => [ev.toolCallId, ev]));
    const expected: Record<string, ToolTrust> = {
      'v2-shell': 'untrusted', 'v2-read': 'trusted', 'v2-fetch': 'untrusted', 'v2-search': 'untrusted',
      'v3-shell': 'untrusted', 'v3-write': 'trusted', michi: 'trusted', 'michi-bare': 'trusted',
      external: 'untrusted', 'external-v3': 'untrusted', 'prose-read': 'trusted', 'prose-grep': 'trusted',
      'prose-other': 'untrusted', 'file-title': 'trusted',
    };
    for (const [id, trust] of Object.entries(expected)) assert.equal(verdict('kiro', byId.get(id)), trust, id);
    assert.deepEqual(pick(byId.get('michi')), { toolName: 'set_branch_overview', mcpServer: 'michi', hostTool: true });
    assert.deepEqual(pick(byId.get('external')), { toolName: 'create_issue', mcpServer: 'github', hostTool: false });
    assert.deepEqual(pick(byId.get('prose-read')), {}, 'a prose title is no name');
    const update = events.find((ev) => ev.kind === 'tool_call_update' && ev.toolCallId === 'v2-shell');
    assert.equal(update?.toolName, 'execute_bash');
  });
});

describe('Antigravity tool calls', () => {
  test('agy names its tools; mcp_michi_<tool> is Michi', async () => {
    const events = await acpToolEvents(ANTIGRAVITY_KIRO_FLAVOR, true, [
      acpCall('a', { name: 'mcp_michi_ask_user', title: 'Run mcp_michi_ask_user', kind: 'other' }),
      acpCall('b', { name: 'mcp_github_search', title: 'Run mcp_github_search', kind: 'other' }),
      acpCall('c', { name: 'run_command', title: 'ls -la', kind: 'execute' }),
      acpCall('d', { name: 'view_file', title: 'File a.ts', kind: 'read' }),
      acpCall('e', { name: 'write_file', title: 'File hello.txt', kind: 'edit' }),
    ]);
    const byId = new Map(events.map((ev) => [ev.toolCallId, ev]));
    assert.deepEqual(pick(byId.get('a')), { toolName: 'ask_user', mcpServer: 'michi', hostTool: true });
    assert.deepEqual(pick(byId.get('b')), { toolName: 'search', mcpServer: 'github', hostTool: false });
    const expected: Record<string, ToolTrust> = { a: 'trusted', b: 'untrusted', c: 'untrusted', d: 'trusted', e: 'trusted' };
    for (const [id, trust] of Object.entries(expected)) assert.equal(verdict('antigravity', byId.get(id)), trust, id);
  });
});

describe('Kiro Crew tool calls', () => {
  test('the Gateway tool name in the title names the call; without one the kind decides', async () => {
    // crewTurn titles a card with the Gateway's `tool` and sends `kind: other` when it has none.
    const events = await acpToolEvents(KIRO_FLAVOR, false, [
      acpCall('a', { title: 'execute_bash', kind: 'other' }),
      acpCall('b', { title: 'fs_read', kind: 'other' }),
      acpCall('c', { title: 'Looked something up', kind: 'other' }),
    ]);
    const byId = new Map(events.map((ev) => [ev.toolCallId, ev]));
    const expected: Record<string, ToolTrust> = { a: 'untrusted', b: 'trusted', c: 'untrusted' };
    for (const [id, trust] of Object.entries(expected)) assert.equal(verdict('crew', byId.get(id)), trust, id);
  });
});

describe('Pi tool calls', () => {
  function started(toolName: string): NormalizedEvent | undefined {
    const ctx: MapperContext = { cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 }, runStartMs: 0 };
    return [...mapAgentEvent({ type: 'tool_execution_start', toolCallId: 'p1', toolName, args: {} }, ctx)][0];
  }

  const cases: Array<[string, ToolTrust]> = [
    ['web_search', 'untrusted'], ['fetch_content', 'untrusted'], ['bash', 'untrusted'], ['mcp__github__get_issue', 'untrusted'],
    ['read', 'trusted'], ['grep', 'trusted'], ['edit', 'trusted'], ['read_node', 'trusted'], ['spawn_branches', 'trusted'],
    ['memory_save', 'trusted'],
  ];
  for (const [name, expected] of cases) {
    test(`${name} is ${expected}`, () => assert.equal(verdict('pi', started(name)), expected));
  }

  test("Pi's tools are Michi's own, but a bridged MCP tool", () => {
    assert.deepEqual(pick(started('read')), { toolName: 'read', hostTool: true });
    assert.deepEqual(pick(started('mcp__github__get_issue')), { toolName: 'get_issue', mcpServer: 'github', hostTool: false });
  });

  test('the end and update events name the tool too', () => {
    const ctx: MapperContext = { cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 }, runStartMs: 0 };
    const end = [...mapAgentEvent({ type: 'tool_execution_end', toolCallId: 'p1', toolName: 'bash', result: 'ok' }, ctx)].at(-1);
    const update = [...mapAgentEvent({ type: 'tool_execution_update', toolCallId: 'p1', toolName: 'web_search', partialResult: 'x' }, ctx)][0];
    assert.equal(verdict('pi', end), 'untrusted');
    assert.equal(verdict('pi', update), 'untrusted');
  });
});
