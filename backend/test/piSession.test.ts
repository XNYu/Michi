import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

type Restore = () => void;

const restores: Restore[] = [];

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
  delete require.cache[require.resolve('../src/agents/pi/PiSession')];
});

test('PiSession resolves model and reasoning against pi runtime, not the active runtime', async () => {
  const agentConfigPath = require.resolve('../src/services/agentConfig');
  const secretsPath = require.resolve('../src/services/secrets');
  const piAiPath = require.resolve('../src/agents/pi/piAi');
  const piToolsPath = require.resolve('../src/agents/pi/piTools');

  let modelRuntime: string | undefined;
  let reasoningRuntime: string | undefined;
  let modelId: string | undefined;
  let thinkingLevel: string | undefined;

  patchModule(agentConfigPath, 'getAgentConfig', () => ({
    runtime: 'kiro',
    provider: 'deepseek',
    modelByRuntime: { kiro: 'kiro-only-model', pi: 'pi-good-model' },
    reasoningByRuntime: { kiro: 'xhigh', pi: 'low' },
  }));
  patchModule(agentConfigPath, 'resolveModel', (runtimeId: string) => {
    modelRuntime = runtimeId;
    return `${runtimeId}-model`;
  });
  patchModule(agentConfigPath, 'resolveReasoning', (runtimeId: string) => {
    reasoningRuntime = runtimeId;
    return runtimeId === 'pi' ? 'low' : 'xhigh';
  });
  patchModule(secretsPath, 'getProviderApiKey', () => 'test-key');
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
    ownerUserId: null,
  });

  for await (const ev of session.send('continue old chat')) {
    if (ev.kind === 'turn_end') break;
  }

  assert.equal(modelRuntime, 'pi');
  assert.equal(reasoningRuntime, 'pi');
  assert.equal(modelId, 'pi-model');
  assert.equal(thinkingLevel, 'low');
});
