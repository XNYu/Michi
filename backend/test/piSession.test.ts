import { restrictedChatProfile } from './helpers/restrictedChatProfile';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { chatOwner, runOwner } from './helpers/owners';

type Restore = () => void;

const restores: Restore[] = [];
const originalMichiCloud = process.env.MICHI_CLOUD;

function patchModule<T extends Record<string, any>, K extends keyof T>(
  modulePath: string,
  key: K,
  value: T[K],
): void {
  const mod = require(modulePath) as T;
  const original = mod[key];
  mod[key] = value;
  restores.push(() => {
    mod[key] = original;
  });
}

afterEach(() => {
  while (restores.length > 0) {
    restores.pop()?.();
  }
  __resetRuntimeDeps();
  delete require.cache[require.resolve('../src/agents/pi/PiSession')];
  if (originalMichiCloud === undefined) delete process.env.MICHI_CLOUD;
  else process.env.MICHI_CLOUD = originalMichiCloud;
});

test('PiSession resolves model and reasoning against pi runtime, not the active runtime', async () => {
  delete process.env.MICHI_CLOUD;
  const piAiPath = require.resolve('../src/agents/pi/piAi');
  const piToolsPath = require.resolve('../src/agents/pi/piTools');

  let modelRuntime: string | undefined;
  let reasoningRuntime: string | undefined;
  let configOwnerUserId: string | undefined;
  let modelOwnerUserId: string | undefined;
  let reasoningOwnerUserId: string | undefined;
  let keyOwnerUserId: string | undefined;
  let brokerOwnerUserId: string | null | undefined;
  let modelId: string | undefined;
  let thinkingLevel: string | undefined;
  let afterToolCall: ((context: { result: unknown; isError: boolean }) => unknown) | undefined;
  let beforeToolCall: ((context: { toolCall: { name: string }; args: unknown }) => Promise<{ block: boolean; reason?: string } | undefined>) | undefined;
  let brokerDecision: 'ask' | 'deny' = 'ask';

  // Replaces the former agentConfig/secrets monkey-patches. Mirrors the exact
  // stub values the patches used to return, including the recording closures
  // that the assertions below depend on.
  configureRuntimeDeps({
    historyStore: {
      getNode: () => null,
      listMessages: () => [],
      getWorkspace: () => null,
      getWorkspaceInstructions: () => null,
    },
    providerKeys: {
      getProviderApiKey: (_provider: string, ownerUserId?: string) => {
        keyOwnerUserId = ownerUserId;
        return 'test-key';
      },
    },
    agentConfig: {
      getAgentConfig: (ownerUserId?: string) => {
        configOwnerUserId = ownerUserId;
        return {
          runtime: 'kiro',
          provider: 'deepseek',
          modelByRuntime: { kiro: 'kiro-only-model', pi: 'pi-good-model' },
          reasoningByRuntime: { kiro: 'xhigh', pi: 'low' },
        };
      },
      resolveModel: (runtimeId: string, ownerUserId?: string) => {
        modelRuntime = runtimeId;
        modelOwnerUserId = ownerUserId;
        return `${runtimeId}-model`;
      },
      resolveReasoning: (runtimeId: string, ownerUserId?: string) => {
        reasoningRuntime = runtimeId;
        reasoningOwnerUserId = ownerUserId;
        return runtimeId === 'pi' ? 'low' : 'xhigh';
      },
    },
    dataDir: '/tmp/agent-runtime-test',
  });
  patchModule(piToolsPath, 'buildPiTools', () => []);
  patchModule(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
  patchModule(piAiPath, 'loadPiAi', async () => ({
    Type: {},
    clampThinkingLevel: (_model: unknown, level: string) => level,
    getModel: (_provider: string, requestedModelId: string) => {
      modelId = requestedModelId;
      return { contextWindow: 1000 };
    },
    streamSimple: () => {
      throw new Error('streamSimple should not be called by this Agent stub');
    },
  }));
  patchModule(piAiPath, 'loadPiAgentCore', async () => ({
    Agent: class {
      state = { messages: [] };
      private subscriber: ((event: any) => void) | undefined;

      constructor(opts: any) {
        thinkingLevel = opts.initialState.thinkingLevel;
        afterToolCall = opts.afterToolCall;
        beforeToolCall = opts.beforeToolCall;
      }

      subscribe(fn: (event: any) => void) {
        this.subscriber = fn;
        return () => {
          this.subscriber = undefined;
        };
      }

      async prompt() {
        this.subscriber?.({ type: 'agent_end' });
      }
    },
  }));

  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  const session = new PiSession('pi-session', {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '',
    cwd: process.cwd(),
    enableFollowUps: true,
    workspaceId: 'workspace-1',
    ownerUserId: 'local-user',
    owner: runOwner('run-1', 'pi-session'),
    toolProfile: { allowedToolNames: ['write'] },
    permissionBroker: {
      requestPermission: async ({ ownerUserId }) => {
        brokerOwnerUserId = ownerUserId;
        return brokerDecision;
      },
    },
  });

  for await (const ev of session.send('continue old chat')) {
    if (ev.kind === 'turn_end') break;
  }

  assert.equal(modelRuntime, 'pi');
  assert.equal(reasoningRuntime, 'pi');
  assert.equal(configOwnerUserId, undefined);
  assert.equal(modelOwnerUserId, undefined);
  assert.equal(reasoningOwnerUserId, undefined);
  assert.equal(keyOwnerUserId, undefined);
  assert.equal(modelId, 'pi-model');
  assert.equal(thinkingLevel, 'low');
  assert.equal(typeof afterToolCall, 'function');
  assert.deepEqual(afterToolCall?.({ result: { isError: true }, isError: false }), { isError: true });
  assert.equal(typeof beforeToolCall, 'function');

  let permissionEvent: any;
  (session as any).activePush = (event: unknown) => { permissionEvent = event; };
  const pending = beforeToolCall!({ toolCall: { name: 'write' }, args: { path: 'notes.md' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(permissionEvent.kind, 'permission_request');
  session.respondToPermission(permissionEvent.requestId, 'allow_once');
  assert.equal(await pending, undefined);

  brokerDecision = 'deny';
  assert.deepEqual(await beforeToolCall!({ toolCall: { name: 'write' }, args: {} }), {
    block: true,
    reason: 'denied by Run permission policy',
  });
  assert.equal(brokerOwnerUserId, 'local-user');
  assert.equal(permissionEvent.options.some((option: any) => option.kind === 'allow_session'), false, 'Run decisions remain separate');

  const chat = new PiSession('pi-chat', {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'workspace-1', ownerUserId: null,
  });
  for await (const event of chat.send('permission test')) { if (event.kind === 'turn_end') break; }
  (chat as any).activePush = (event: unknown) => { permissionEvent = event; };
  const chatPending = beforeToolCall!({ toolCall: { name: 'write' }, args: { path: 'test' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(permissionEvent.options.length, 4);
  chat.respondToPermission(permissionEvent.requestId, 'allow_session');
  assert.equal(await chatPending, undefined);
  assert.equal(await beforeToolCall!({ toolCall: { name: 'bash' }, args: {} }), undefined, 'later Pi tools inherit session trust');
  assert.equal((chat as any).pendingPermissions.size, 0);
});

test('PiSession sends thread messages directly but explicitly requested approval stays single-use', async () => {
  delete process.env.MICHI_CLOUD;
  const piAiPath = require.resolve('../src/agents/pi/piAi');
  const piToolsPath = require.resolve('../src/agents/pi/piTools');
  let toolOpts: any;
  let beforeToolCall: ((context: { toolCall: { name: string }; args: unknown }) => Promise<{ block: boolean; reason?: string } | undefined>) | undefined;
  configureRuntimeDeps({
    historyStore: {
      getNode: () => null, listMessages: () => [], getWorkspace: () => null,
      getWorkspaceInstructions: () => null,
    },
    providerKeys: { getProviderApiKey: () => 'test-key' },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'pi', provider: 'deepseek', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => 'pi-model',
      resolveReasoning: () => undefined,
    },
    dataDir: '/tmp/agent-runtime-test',
  });
  patchModule(piToolsPath, 'buildPiTools', (opts: any) => { toolOpts = opts; return []; });
  patchModule(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
  patchModule(piAiPath, 'loadPiAi', async () => ({
    Type: {},
    clampThinkingLevel: (_model: unknown, level: string) => level,
    getModel: () => ({ contextWindow: 1000 }),
    streamSimple: () => { throw new Error('not used'); },
  }));
  patchModule(piAiPath, 'loadPiAgentCore', async () => ({
    Agent: class {
      state = { messages: [] };
      private subscriber: ((event: any) => void) | undefined;
      constructor(opts: any) { beforeToolCall = opts.beforeToolCall; }
      subscribe(fn: (event: any) => void) { this.subscriber = fn; return () => { this.subscriber = undefined; }; }
      async prompt() { this.subscriber?.({ type: 'agent_end' }); }
    },
  }));

  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  const chat = new PiSession('pi-thread-chat', {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'workspace-1', ownerUserId: null,
    owner: chatOwner('n-a'),
  });
  for await (const event of chat.send('build tools')) { if (event.kind === 'turn_end') break; }
  assert.equal(typeof toolOpts?.requestThreadMessageApproval, 'function');

  const events: any[] = [];
  (chat as any).activePush = (event: unknown) => { events.push(event); };
  assert.equal(await beforeToolCall!({ toolCall: { name: 'send_to_thread' }, args: { nodeId: 'n-b', text: 'progress' } }), undefined);
  assert.equal(events.length, 0, 'routine messages do not open a runtime permission card');
  const request = { targetNodeId: 'n-b', targetTitle: 'Implementation', text: 'Please review' };

  const approval = toolOpts.requestThreadMessageApproval(request);
  await new Promise((resolve) => setImmediate(resolve));
  const explicit = events.at(-1);
  assert.equal(explicit.kind, 'permission_request');
  assert.equal(explicit.title, 'Send a message to "Implementation"?');
  assert.equal(explicit.detail, 'Please review');
  assert.deepEqual(explicit.options.map((option: any) => option.optionId).sort(), ['allow_once', 'reject_once']);

  // Granting session trust to another tool must not approve the pending message.
  const other = beforeToolCall!({ toolCall: { name: 'write' }, args: { path: 'x' } });
  await new Promise((resolve) => setImmediate(resolve));
  chat.respondToPermission(events.at(-1).requestId, 'allow_session');
  assert.equal(await other, undefined);
  assert.equal((chat as any).pendingPermissions.has(explicit.requestId), true, 'explicit approval must still be pending');

  chat.respondToPermission(explicit.requestId, 'allow_once');
  assert.deepEqual(await approval, { approved: true });

  // Session trust does not pre-approve the next message, and only allow_once approves.
  const next = toolOpts.requestThreadMessageApproval(request);
  await new Promise((resolve) => setImmediate(resolve));
  const second = events.at(-1);
  assert.notEqual(second.requestId, explicit.requestId);
  chat.respondToPermission(second.requestId, 'allow_always');
  assert.deepEqual(await next, { approved: false, reason: 'declined' });
});

function stubPiForMetaAgent(builtTools: string[]): { agentTools: () => string[] | undefined; buildCalls: () => number; prompts: string[] } {
  delete process.env.MICHI_CLOUD;
  let tools: string[] | undefined;
  let buildCalls = 0;
  const prompts: string[] = [];
  configureRuntimeDeps({
    historyStore: {
      getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null,
    },
    providerKeys: { getProviderApiKey: () => 'test-key' },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'pi', provider: 'deepseek', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => 'pi-model',
      resolveReasoning: () => 'low',
    },
    dataDir: '/tmp/agent-runtime-test',
  });
  patchModule(require.resolve('../src/agents/pi/piTools'), 'buildPiTools', () => {
    buildCalls += 1;
    return builtTools.map((name) => ({ name, label: name, description: name, parameters: {}, execute: async () => ({}) }));
  });
  patchModule(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => { throw new Error('a Meta agent reads no user MCP config'); });
  const piAiPath = require.resolve('../src/agents/pi/piAi');
  patchModule(piAiPath, 'loadPiAi', async () => ({
    Type: new Proxy({}, { get: () => (..._a: any[]) => ({}) }),
    clampThinkingLevel: (_model: unknown, level: string) => level,
    getModel: () => ({ contextWindow: 1000 }),
    streamSimple: () => { throw new Error('unused'); },
  }));
  patchModule(piAiPath, 'loadPiAgentCore', async () => ({
    Agent: class {
      state: any;
      private subscriber: ((event: any) => void) | undefined;
      constructor(opts: any) {
        this.state = { messages: [], tools: opts.initialState.tools };
        tools = opts.initialState.tools.map((tool: { name: string }) => tool.name);
      }
      subscribe(fn: (event: any) => void) { this.subscriber = fn; return () => { this.subscriber = undefined; }; }
      async prompt(text: string) { prompts.push(text); this.subscriber?.({ type: 'agent_end' }); }
    },
  }));
  return { agentTools: () => tools, buildCalls: () => buildCalls, prompts };
}

function newPiMetaSession(id: string, toolProfile: unknown): any {
  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  return new PiSession(id, {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'workspace-1', ownerUserId: null,
    owner: { mode: 'interactive', key: id },
    toolProfile: toolProfile as any,
  });
}

async function drainPi(session: any, text: string, input?: unknown): Promise<void> {
  for await (const event of session.send(text, input)) { if (event.kind === 'turn_end') break; }
}

test('Pi Meta agent chat: only the chat toolset reaches the model', async () => {
  const { assistantToolProfile, META_AGENT_CHAT_TOOL_NAMES } = require('../src/assistant/policy') as typeof import('../src/assistant/policy');
  const stub = stubPiForMetaAgent(['list_threads', 'send_to_thread', 'bash', 'read_page', 'save_artifact']);
  const session = newPiMetaSession('n-chat', restrictedChatProfile());
  await drainPi(session, 'what is waiting?');
  assert.deepEqual(stub.agentTools(), ['list_threads', 'read_page']);
  assert.ok(stub.agentTools()!.every((name) => META_AGENT_CHAT_TOOL_NAMES.includes(name)));
});

test('Pi Michi chat omits metadata glue and reminders on fresh and restored turns', async () => {
  const { assistantToolProfile } = require('../src/assistant/policy') as typeof import('../src/assistant/policy');
  const { buildFormatReminder } = require('../src/agents/preamble') as typeof import('../src/agents/preamble');
  const { rowsToAgentMessages } = require('../src/agents/pi/historyAdapter') as typeof import('../src/agents/pi/historyAdapter');
  const stub = stubPiForMetaAgent(['list_threads', 'read_page']);
  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  for (const restored of [false, true]) {
    const session = new PiSession(`michi-${restored}`, {
      bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
      preamble: '', cwd: process.cwd(), enableFollowUps: true,
      firstUserGlue: buildFormatReminder(true), workspaceId: 'workspace-1', ownerUserId: null,
      toolProfile: restrictedChatProfile(),
      ...(restored ? { initialMessages: rowsToAgentMessages([
        { role: 'user', content: 'Earlier question', created_at: 1 },
        { role: 'assistant', content: 'Earlier answer', created_at: 2 },
      ]) } : {}),
    });
    for (const question of ['What is waiting?', 'What changed?', 'What should I read?']) {
      await drainPi(session, question);
      assert.equal(stub.prompts.at(-1), question, 'the provider receives the question without chat metadata directives');
    }
    session.destroy();
  }
});

test('Pi sends the Michi Memory block ahead of the Pages context for the model only', async () => {
  const stub = stubPiForMetaAgent([]);
  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  const session = new PiSession('pi-memory', {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'workspace-1', ownerUserId: null,
    owner: chatOwner('pi-memory'),
  });
  await drainPi(session, 'first question', {
    memoryContext: '<michi-memory>\n- Reply in Chinese. (preference)\n</michi-memory>',
    pageContext: 'Michi Pages manifest (JSON): {}',
  });
  await drainPi(session, 'second question');
  assert.equal(stub.prompts[0], '<michi-memory>\n- Reply in Chinese. (preference)\n</michi-memory>\n\n---\n\nMichi Pages manifest (JSON): {}\n\n---\n\nfirst question');
  assert.equal(stub.prompts[1], 'second question', 'a turn without a block sends none');
  assert.deepEqual(session.getHistory().filter((m) => m.role === 'user').map((m) => m.content), ['first question', 'second question']);
  session.destroy();
});

test('Pi Meta agent chat: a tool that slips past the allow-list stops the run with MetaAgentGuardError', async () => {
  const { assistantToolProfile } = require('../src/assistant/policy') as typeof import('../src/assistant/policy');
  const { MetaAgentGuardError } = require('../src/agents/metaAgentGuard') as typeof import('../src/agents/metaAgentGuard');
  const stub = stubPiForMetaAgent(['list_threads', 'bash']);
  const session = newPiMetaSession('n-chat-leak', restrictedChatProfile());
  session.isToolAllowed = () => true;
  await assert.rejects(drainPi(session, 'hi'), (error: unknown) => error instanceof MetaAgentGuardError
    && error.violation.runtimeId === 'pi' && error.violation.toolset === 'chat' && error.violation.unexpectedTools.join() === 'bash');
  assert.equal(stub.agentTools(), undefined, 'no agent was built');
});

test('Pi Meta agent maintenance: only the dedicated maintenance tools, never the chat builtins', async () => {
  const { maintenanceToolProfile, META_AGENT_MAINTENANCE_TOOL_NAMES } = require('../src/agents/maintenancePolicy') as typeof import('../src/agents/maintenancePolicy');
  const stub = stubPiForMetaAgent(['list_threads', 'read_node', 'bash']);
  const session = newPiMetaSession('n-maint', maintenanceToolProfile());
  await drainPi(session, 'maintain', {
    turnId: 't-1', assistantMessageId: 'a-1',
    maintenanceContext: {
      workspaceId: 'workspace-1', ownerUserId: 'local-user', jobId: 'job-1', runId: 'run-1', claimedBy: 'w', configRevision: 1, planId: 'plan-1', sources: [],
    },
  });
  assert.equal(stub.buildCalls(), 0);
  assert.deepEqual(stub.agentTools(), [...META_AGENT_MAINTENANCE_TOOL_NAMES]);
});

test('Pi automatic memory: only the four extraction tools, never maintenance or chat tools', async () => {
  const { memoryExtractionToolProfile, MEMORY_EXTRACTION_TOOL_NAMES } = require('../src/services/memory/extractionProfile') as typeof import('../src/services/memory/extractionProfile');
  const stub = stubPiForMetaAgent(['list_threads', 'memory_search', 'bash']);
  const session = newPiMetaSession('n-memory', memoryExtractionToolProfile());
  await drainPi(session, 'extract', {
    turnId: 't-1', assistantMessageId: 'a-1',
    maintenanceContext: {
      workspaceId: 'workspace-1', ownerUserId: 'local-user', jobId: 'job-1', runId: 'run-1', claimedBy: 'w', configRevision: 1, planId: 'mxr-1', sources: [],
    },
  });
  assert.equal(stub.buildCalls(), 0, 'no chat builtins, including a chat memory tool of the same name');
  assert.deepEqual(stub.agentTools(), [...MEMORY_EXTRACTION_TOOL_NAMES]);
});
