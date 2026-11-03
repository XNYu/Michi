import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { loadPiAi } from '../src/agents/pi/piAi';
import { chatOwner } from './helpers/owners';

test('PiRuntime default SDK send keeps host policy, attachments, display history and native recovery', async (t) => {
  const ai: any = await loadPiAi();
  const piAi = require('../src/agents/pi/piAi');
  const piTools = require('../src/agents/pi/piTools');
  const mcp = require('../src/services/piMcpConfig');
  const originals = [piAi.loadPiAi, piTools.buildPiTools, mcp.readPiMcpServers];
  const cwd = process.env.MICHI_DATA_DIR!;
  fs.mkdirSync(cwd, { recursive: true });
  const image = path.join(cwd, 'synthetic.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=', 'base64'));
  let rows: any[] = [];
  let requests = 0, executions = 0;
  let denied = false;
  let captured: any;
  const expectedKeys: string[] = [];
  configureRuntimeDeps({
    dataDir: cwd,
    historyStore: { getNode: () => ({ id: 'sdk-host', workspace_id: 'workspace' } as any), listMessages: () => rows,
      getWorkspace: () => null, getWorkspaceInstructions: () => 'Synthetic workspace instruction.' },
    providerKeys: { getProviderApiKey: () => 'synthetic-host-key' },
    agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'openai', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => 'gpt-4.1-mini', resolveReasoning: () => undefined },
  });
  mcp.readPiMcpServers = () => [];
  piTools.buildPiTools = () => [{ name: 'probe', label: 'Probe', description: 'Host probe', parameters: ai.Type.Object({}),
    async execute() { executions++; return { content: [{ type: 'text', text: 'HOST-TOOL-7391' }], details: {} }; } }];
  piAi.loadPiAi = async () => ({ ...ai, streamSimple: (model: any, context: any, options: any) => {
    captured = context;
    expectedKeys.push(options.apiKey);
    const toolCall = requests++ % 2 === 0;
    const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: toolCall ? [{ type: 'toolCall', id: `call-${requests}`, name: 'probe', arguments: {} }]
        : [{ type: 'text', text: '[TITLE: Synthetic title]\n\nHOST ANSWER\n\n[FOLLOW-UP 1/3: Next]' }],
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: toolCall ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      if (!toolCall) stream.push({ type: 'text_delta', delta: message.content[0].text, contentIndex: 0, partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message });
    });
    return stream;
  } });
  let extensionScopes = 0, extensionStarts = 0;
  const runtime = new PiRuntime({ spawnBranches: async () => [], saveContext: () => null, updateContext: () => null }, {
    extensionFactories(scope) {
      assert.equal(scope.ownerUserId, 'user');
      assert.equal(scope.workspaceId, 'workspace');
      extensionScopes++;
      return [(pi: any) => { pi.on('session_start', () => { extensionStarts++; }); }];
    },
  });
  t.after(async () => {
    await runtime.shutdown(); clearAllSessions(); __resetRuntimeDeps();
    [piAi.loadPiAi, piTools.buildPiTools, mcp.readPiMcpServers] = originals;
  });
  const opts = { sessionId: 'sdk-host', owner: chatOwner('sdk-host'), ownerUserId: 'user', workspaceId: 'workspace', cwd,
    provider: 'openai', model: 'gpt-4.1-mini', enableFollowUps: false,
    toolProfile: { allowedToolNames: ['probe'] },
    permissionBroker: { requestPermission: async () => denied ? 'deny' as const : 'allow_once' as const } };
  const fresh = await runtime.newSession(opts);
  const events: any[] = [];
  for await (const event of fresh.send('Model-only expanded input', { attachments: [{ name: 'synthetic.png', absPath: image }] })) {
    events.push(event);
    if (event.kind === 'turn_end') {
      // Match ChatHub: commit the canonical projection before closing send().
      rows = [{ role: 'user', content: 'Displayed input', created_at: 1 }, { role: 'assistant', content: 'HOST ANSWER', created_at: 2 }];
      break;
    }
  }
  assert.equal(fresh.describeNativeState?.().kind, 'pi-sdk');
  assert.equal(executions, 1);
  assert(events.some(event => event.kind === 'tool_call_update' && event.status === 'completed'));
  assert(events.some(event => event.kind === 'chunk' && event.text.includes('HOST ANSWER')), JSON.stringify(events));
  assert(captured.messages.some((message: any) => message.role === 'user' && message.content.some((block: any) => block.type === 'image')));
  assert(expectedKeys.every(key => key === 'synthetic-host-key'));
  await runtime.releaseSession(fresh.id, opts.owner);
  const loaded = await runtime.newSession({ ...opts, replayHistory: rows.map(row => ({ role: row.role, content: row.content })) });
  denied = true;
  for await (const event of loaded.send('Continue')) {
    if (event.kind === 'turn_end') break;
  }
  assert.equal(executions, 1, 'SDK continues to enforce the Michi broker');
  assert(captured.messages.some((message: any) => message.role === 'toolResult' && JSON.stringify(message).includes('HOST-TOOL-7391')),
    'native tool context survives a restart even with displayText and finalized metadata');
  assert.equal(extensionScopes, 2);
  assert.equal(extensionStarts, 2);
  assert.deepEqual(loaded.getHistory().slice(0, 2), [{ role: 'user', content: 'Displayed input' }, { role: 'assistant', content: 'HOST ANSWER' }]);
});
