import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PiSessionDeps } from '../src/agents/pi/PiSession';
import { createPiSdkHarness } from '../src/agents/pi/piSdkHarness';
import {
  deferMcpTools, estimateToolDefinitionTokens, MCP_TOOL_SEARCH_AUTO_TOKENS, renderDeferredMcpSection, shouldDeferMcpTools,
} from '../src/agents/pi/mcpToolBridge';
import { loadPiAi, loadPiAgentCore, loadPiTypebox } from '../src/agents/pi/piAi';
import { runOwner } from './helpers/owners';

const deps: PiSessionDeps = {
  bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
  preamble: 'Only follow the host prompt.', cwd: '/tmp', enableFollowUps: false,
  workspaceId: 'workspace', ownerUserId: 'user', owner: runOwner('run', 'tool-search'), profileHash: 'profile',
};

const usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function tool(Type: any, name: string, description: string, onRun?: () => void) {
  return {
    name, label: name, description, parameters: Type.Object({}),
    async execute() { onRun?.(); return { content: [{ type: 'text', text: `${name} ran` }], details: {} }; },
  };
}

/** A synthetic provider that plays the given assistant turns and records each request. */
function scriptedStream(ai: any, model: any, turns: Array<() => any[]>, requests: any[]) {
  return (_model: any, context: any) => {
    requests.push(context);
    const content = (turns[requests.length - 1] ?? (() => [{ type: 'text', text: 'DONE' }]))();
    const stopReason = content.some((block: any) => block.type === 'toolCall') ? 'toolUse' : 'stop';
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({ type: 'done', reason: stopReason, message: {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, usage, stopReason, timestamp: Date.now(),
    } }));
    return stream;
  };
}

test('MCP deferral: off, forced, allowlisted and auto by definition size', async () => {
  const { Type } = await loadPiTypebox();
  const small = [tool(Type, 'mcp__docs__search', 'Search docs')];
  const big = Array.from({ length: 200 }, (_, index) => tool(Type, `mcp__spec__tool_${index}`, 'Spec Studio operation. '.repeat(10)));
  assert(estimateToolDefinitionTokens(big) >= MCP_TOOL_SEARCH_AUTO_TOKENS);
  assert.equal(shouldDeferMcpTools({ tools: small, allowlisted: false }), false, 'a small catalog stays declared');
  assert.equal(shouldDeferMcpTools({ tools: big, allowlisted: false }), true);
  assert.equal(shouldDeferMcpTools({ tools: small, mode: '1', allowlisted: false }), true);
  assert.equal(shouldDeferMcpTools({ tools: big, mode: 'off', allowlisted: false }), false);
  assert.equal(shouldDeferMcpTools({ tools: big, mode: '1', allowlisted: true }), false, 'an explicit Run loadout stays declared');
  assert.equal(shouldDeferMcpTools({ tools: [], mode: '1', allowlisted: false }), false);

  const deferred = deferMcpTools([...small, tool(Type, 'read_node', 'Host tool')]);
  assert.equal(deferred[0].exposure, 'deferred');
  assert.deepEqual(deferred[0].namespace.aliases, ['docs']);
  assert.equal(deferred[1].exposure, undefined, 'only mcp__ tools are deferred');
  const section = renderDeferredMcpSection([...deferred, ...deferMcpTools(big)])!;
  assert.match(section, /tool_search/);
  assert.match(section, /- docs \(1 tool\)/);
  assert.match(section, /- spec \(200 tools\)/);
  assert.equal(renderDeferredMcpSection(small), undefined);
});

test('deferred MCP tools stay undeclared until tool_search loads them, and stay loaded on resume', async () => {
  const ai: any = await loadPiAi();
  const core: any = await loadPiAgentCore();
  const { Type } = await loadPiTypebox();
  const model = ai.getModel('openai', 'gpt-4.1-mini');
  let ran = 0;
  const hostTools = [
    tool(Type, 'probe', 'A synthetic host tool'),
    ...deferMcpTools([
      tool(Type, 'mcp__sheets__create_report', 'Create a spreadsheet report', () => { ran++; }),
      tool(Type, 'mcp__weather__forecast', 'Get the weather forecast'),
    ]),
  ];
  const requests: any[] = [];
  const gated: string[] = [];
  const options = {
    initialState: { systemPrompt: deps.preamble, model, tools: hostTools, thinkingLevel: 'off', messages: [] },
    beforeToolCall: async ({ toolCall }: any) => { gated.push(toolCall.name); return undefined; },
    streamFn: scriptedStream(ai, model, [
      () => [{ type: 'toolCall', id: 'search-1', name: 'tool_search', arguments: { query: 'spreadsheet report' } }],
      () => [{ type: 'toolCall', id: 'call-1', name: 'mcp__sheets__create_report', arguments: {} }],
    ], requests),
  };
  const declared = (context: any) => ai.getCurrentTools(context.messages).map((t: any) => t.name).sort();
  const harness = await createPiSdkHarness('tool-search', deps, core, options);
  await harness.configureAuth(model.provider, 'synthetic-test-key');
  try {
    await harness.prompt('Make a report');
    assert.deepEqual(declared(requests[0]), ['probe', 'tool_search'], 'MCP tools are not declared upfront');
    assert.match(ai.getCurrentSystemPrompt(requests[0].messages), /- sheets \(1 tool\)[\s\S]*- weather \(1 tool\)/);
    assert.deepEqual(declared(requests[1]), ['mcp__sheets__create_report', 'probe', 'tool_search'], 'only the match is loaded');
    assert.equal(ran, 1, 'the loaded tool runs as a direct call');
    assert.deepEqual(gated, ['tool_search', 'mcp__sheets__create_report'], 'both calls pass the host gate');

    // A server connecting later registers deferred, not active.
    await harness.updateTools([...hostTools, ...deferMcpTools([tool(Type, 'mcp__weather__alerts', 'Weather alerts')])]);
    assert.deepEqual(harness.state.tools.map((t: any) => t.name).sort(), ['mcp__sheets__create_report', 'probe', 'tool_search']);

    harness.checkpoint([]);
    const resumed = await createPiSdkHarness('tool-search', { ...deps, restoreNative: true }, core, options);
    try {
      assert.deepEqual(resumed.state.tools.map((t: any) => t.name).sort(), ['mcp__sheets__create_report', 'probe', 'tool_search'],
        'a resumed branch keeps what tool_search loaded');
    } finally { await resumed.dispose(); }

    // Without deferred tools tool_search is neither declared nor described.
    await harness.updateTools([hostTools[0]]);
    assert.deepEqual(harness.state.tools.map((t: any) => t.name), ['probe']);
  } finally { await harness.dispose(); }
});

test('project AGENTS.md reaches the system prompt only when the host enables it', async () => {
  const ai: any = await loadPiAi();
  const core: any = await loadPiAgentCore();
  const model = ai.getModel('openai', 'gpt-4.1-mini');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pi-context-'));
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'PROJECT-RULE-4471: run the focused tests.');
  const nested = path.join(project, 'packages', 'app');
  fs.mkdirSync(nested, { recursive: true });
  try {
    for (const projectContext of [true, false]) {
      const requests: any[] = [];
      const harness = await createPiSdkHarness(`context-${projectContext}`, { ...deps, cwd: nested }, core, {
        initialState: { systemPrompt: deps.preamble, model, tools: [], thinkingLevel: 'off', messages: [] },
        streamFn: scriptedStream(ai, model, [], requests),
      }, { projectContext });
      await harness.configureAuth(model.provider, 'synthetic-test-key');
      try {
        await harness.prompt('Hello');
        const prompt = ai.getCurrentSystemPrompt(requests[0].messages);
        assert.match(prompt, /Only follow the host prompt\./, 'the host prompt stays the preamble');
        assert.equal(prompt.includes('PROJECT-RULE-4471'), projectContext, 'an ancestor AGENTS.md is read only when enabled');
      } finally { await harness.dispose(); }
    }
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
