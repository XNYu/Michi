import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { PiSession, type PiSessionDeps } from '../src/agents/pi/PiSession';
import { PiSdkSession, createPiSession, selectPiSessionKind, shouldNavigatePiTreeOnMichiBranch } from '../src/agents/pi/PiSdkSession';
import { createPiSdkHarness, piSdkSessionDirectory, invalidatePiSdkTranscript } from '../src/agents/pi/piSdkHarness';
import { loadPiAi, loadPiAgentCore, loadPiTypebox } from '../src/agents/pi/piAi';
import { runOwner } from './helpers/owners';

const deps: PiSessionDeps = {
  bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
  preamble: 'Only follow the host prompt.', cwd: '/tmp', enableFollowUps: false,
  workspaceId: 'workspace', ownerUserId: 'user', owner: runOwner('run', 'attempt'), profileHash: 'profile',
};

test('complete SDK is the default with an explicit agent-core rollback', async () => {
  assert.equal(selectPiSessionKind({}), 'sdk');
  assert.equal(selectPiSessionKind({ MICHI_PI_SESSION_SDK: '1' }), 'sdk');
  assert.equal(selectPiSessionKind({ MICHI_PI_SESSION_SDK: '0' }), 'agent-core');
  const session = await createPiSession('attempt', deps);
  assert(session instanceof PiSdkSession);
  assert(session instanceof PiSession);
  assert.deepEqual(session.owner, deps.owner);
  assert.equal(session.runtimeProfileHash, 'profile');
  assert.equal(typeof session.respondToPermission, 'function');
  assert.equal(typeof session.cancelPermission, 'function');
  assert.equal(typeof session.steer, 'function');
  assert.equal(shouldNavigatePiTreeOnMichiBranch(), false);
  await (session as PiSession).dispose();
});

test('SDK transcript paths isolate user, workspace, owner, profile and branch', () => {
  const base = piSdkSessionDirectory('attempt', deps);
  const variations = [
    piSdkSessionDirectory('child', deps),
    piSdkSessionDirectory('attempt', { ...deps, ownerUserId: 'other' }),
    piSdkSessionDirectory('attempt', { ...deps, workspaceId: 'other' }),
    piSdkSessionDirectory('attempt', { ...deps, owner: runOwner('other', 'attempt') }),
    piSdkSessionDirectory('attempt', { ...deps, profileHash: 'other' }),
  ];
  assert.equal(new Set([base, ...variations]).size, 6);
});

test('real SDK persists tool context, applies host denial, restores independently and accepts post-cancel prompts', async () => {
  const ai: any = await loadPiAi();
  const core: any = await loadPiAgentCore();
  const { Type } = await loadPiTypebox();
  const model = ai.getModel('openai', 'gpt-4.1-mini');
  let executions = 0;
  let requests = 0;
  let denied = true;
  let captured: any;
  let wait = false;
  let waitStarted!: () => void;
  let started = new Promise<void>(resolve => { waitStarted = resolve; });
  let releaseWait: () => void = () => {};
  const tool = {
    name: 'probe', label: 'Probe', description: 'A synthetic host tool', parameters: Type.Object({}),
    async execute(_id: string, _args: any, signal?: AbortSignal) {
      executions++;
      if (wait) {
        waitStarted();
        await new Promise<void>((resolve, reject) => {
          releaseWait = resolve;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return { content: [{ type: 'text', text: 'SYNTHETIC-7391' }], details: {} };
    },
  };
  const options = {
    initialState: { systemPrompt: deps.preamble, model, tools: [tool], thinkingLevel: 'off', messages: [] },
    beforeToolCall: async () => denied ? { block: true, reason: 'Host denied' } : undefined,
    streamFn: (_model: any, context: any) => {
      captured = context;
      const stream = ai.createAssistantMessageEventStream();
      const result = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: requests++ % 2 === 0 ? [{ type: 'toolCall', id: `call-${requests}`, name: 'probe', arguments: {} }]
          : [{ type: 'text', text: 'DONE' }],
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: requests % 2 === 1 ? 'toolUse' : 'stop', timestamp: Date.now(),
      };
      queueMicrotask(() => { stream.push({ type: 'done', reason: result.stopReason, message: result }); });
      return stream;
    },
  };
  let starts = 0, shuts = 0;
  const scopedDeps = { ...deps, sdkExtensionFactories: [(pi: any) => {
    pi.registerTool({ ...tool, name: 'extension_probe' });
    pi.registerTool({ ...tool, name: 'hidden_probe', defaultActive: false });
    pi.on('session_start', () => { starts++; });
    pi.on('session_shutdown', () => { shuts++; });
  }] };
  const harness = await createPiSdkHarness('sdk-lifecycle', scopedDeps, core, options);
  assert.equal(starts, 1);
  await harness.configureAuth(model.provider, 'synthetic-test-key');
  const events: any[] = [];
  harness.subscribe((event: any) => events.push(event));
  try {
    await harness.prompt('Denied probe');
    assert.equal(executions, 0);
    assert(events.some(event => event.type === 'tool_execution_end' && event.isError));
    assert.equal(events.at(-1)?.type, 'agent_end');
    denied = false;
    await harness.prompt('Allowed probe', [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=' }]);
    assert.equal(executions, 1);
    assert(captured.messages.some((message: any) => message.role === 'user' && message.content.some((block: any) => block.type === 'image')));
    assert.deepEqual(harness.state.tools.map((t: any) => t.name).sort(), ['extension_probe', 'probe'], 'Only host-selected tools');
    const file = path.join(piSdkSessionDirectory('sdk-lifecycle', deps), 'session.jsonl');
    assert(fs.readFileSync(file, 'utf8').includes('SYNTHETIC-7391'));
    harness.checkpoint([]);
    const resumed = await createPiSdkHarness('sdk-lifecycle', { ...deps, restoreNative: true }, core, options);
    try { assert(resumed.state.messages.some((message: any) => message.role === 'toolResult' && JSON.stringify(message).includes('SYNTHETIC-7391'))); }
    finally { await resumed.dispose(); }
    const branch = await createPiSdkHarness('sdk-child', deps, core, options);
    try { assert(!branch.state.messages.some((message: any) => message.role === 'toolResult')); }
    finally { await branch.dispose(); }
    await harness.updateTools([{ ...tool, description: 'Refreshed schema and implementation',
      parameters: Type.Object({ revision: Type.Optional(Type.String()) }),
      async execute() { return { content: [{ type: 'text', text: 'UPDATED-HANDLER' }], details: {} }; },
    }]);
    assert(harness.state.tools.some((t: any) => t.name === 'extension_probe'), 'Extension tools survive host refresh');
    assert(!harness.state.tools.some((t: any) => t.name === 'hidden_probe'), 'Explicitly hidden extension tools stay hidden');
    requests = 0;
    await harness.prompt('Use refreshed tool');
    const refreshed = harness.state.tools.find((t: any) => t.name === 'probe');
    assert.equal(refreshed.description, 'Refreshed schema and implementation');
    assert(refreshed.parameters.properties.revision);
    assert(fs.readFileSync(file, 'utf8').includes('UPDATED-HANDLER'));
    await harness.updateTools([tool]);
    requests = 0;
    wait = true;
    const steering = harness.prompt('Steer probe');
    await started;
    await harness.steer({ role: 'user', content: [{ type: 'text', text: 'STEERED-HOST-INPUT' }], timestamp: Date.now() });
    releaseWait();
    await steering;
    assert(captured.messages.some((message: any) => message.role === 'user' && message.content.some((block: any) => block.text === 'STEERED-HOST-INPUT')));
    started = new Promise<void>(resolve => { waitStarted = resolve; });
    requests = 0;
    const running = harness.prompt('Wait probe');
    await started;
    harness.abort();
    await running;
    wait = false;
    requests = 1;
    await harness.prompt('Continue');
    assert.equal(harness.state.isStreaming, false);
    // A replay cut or a rollback round must not silently resume older JSONL.
    harness.checkpoint([]);
    invalidatePiSdkTranscript('sdk-lifecycle', deps);
    const replaced = await createPiSdkHarness('sdk-lifecycle', { ...deps, restoreNative: true }, core, options);
    try { assert.equal(replaced.state.messages.some((message: any) => message.role === 'toolResult'), false); }
    finally { await replaced.dispose(); }
    assert(fs.readdirSync(path.dirname(file)).some(name => name.startsWith('retired-')));
  } finally { await harness.dispose(); }
  assert.equal(shuts, 1);
});

test('SDK auto-compaction runs against a synthetic stream and finishes before agent_end', async () => {
  const ai: any = await loadPiAi();
  const core = await loadPiAgentCore();
  const model = { ...ai.getModel('openai', 'gpt-4.1-mini'), contextWindow: 65536 };
  const usage = { input: 52000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 52020, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const messages: any[] = [];
  for (let index = 0; index < 20; index++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `Synthetic ${index}: ` + 'harmless context '.repeat(800) }], timestamp: Date.now() });
    messages.push({ role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'Recorded synthetic context.' }], usage, stopReason: 'stop', timestamp: Date.now() });
  }
  const events: any[] = [];
  const harness = await createPiSdkHarness('sdk-compaction', { ...deps, initialMessages: messages }, core, {
    initialState: { systemPrompt: deps.preamble, model, tools: [], messages, thinkingLevel: 'off' },
    streamFn: () => {
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: 'Synthetic summary: all harmless records are complete.' }],
        usage: { ...usage, input: 10, totalTokens: 30 }, stopReason: 'stop', timestamp: Date.now(),
      } }));
      return stream;
    },
  });
  await harness.configureAuth(model.provider, 'synthetic-test-key');
  harness.subscribe((event: any) => events.push(event));
  try {
    await harness.prompt('Continue after compression');
    assert(events.some(event => event.type === 'compaction_start'));
    assert(events.some(event => event.type === 'compaction_end' && !event.errorMessage));
    assert(harness.state.messages.some((message: any) => message.role === 'compactionSummary'));
    assert.equal(events.at(-1)?.type, 'agent_end');
  } finally { await harness.dispose(); }
});

test('an explicitly handled SDK input still ends the owning Michi turn', async () => {
  const ai: any = await loadPiAi();
  const core = await loadPiAgentCore();
  let handled = 0;
  const harness = await createPiSdkHarness('sdk-handled', {
    ...deps, sdkExtensionFactories: [(pi: any) => pi.on('input', () => { handled++; return { action: 'handled' }; })],
  }, core, {
    initialState: { systemPrompt: deps.preamble, model: ai.getModel('openai', 'gpt-4.1-mini'), tools: [], messages: [] },
    streamFn: () => { throw new Error('A handled input must not contact a provider'); },
  });
  const events: any[] = [];
  harness.subscribe((event: any) => events.push(event));
  try {
    await harness.prompt('Handled by host extension');
    assert.equal(handled, 1);
    assert.equal(events.at(-1)?.type, 'agent_end');
    assert.equal(harness.state.isStreaming, false);
  } finally { await harness.dispose(); }
});
