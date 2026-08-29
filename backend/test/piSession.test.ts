import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';

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
      hasGrant: () => false,
      grantPermission: () => {},
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
  patchModule(piAiPath, 'loadPiAi', async () => ({
    Type: {},
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
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'pi-session' },
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
});
