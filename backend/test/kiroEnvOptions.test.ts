/**
 * Kiro and Crew take their settings as KiroAdapterOptions; Michi reads them
 * from the environment (michiKiroOptions.ts, used by the factories) with the
 * parsing KiroRuntime and AcpClient used, at the same moments: four were
 * module constants, read once when the module loaded, and still are; the
 * concurrency cap is read when a runtime is created; the rest each time they
 * are used.
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type * as Factories from '../src/agents/runtimeFactories';
import type * as KiroOptions from '../src/agents/michiKiroOptions';
import { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { michiTestHost } from './helpers/michiTestHost';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';

const ENV = [
  'MICHI_KIRO_MAX_PROCESSES', 'MICHI_KIRO_IDLE_TTL_MS', 'MICHI_KIRO_WARM_POOL_SIZE', 'ACP_TIMEOUT_MS',
  'MICHI_KIRO_MAX_CONCURRENT', 'MICHI_APPROVE_TIMEOUT_MS', 'MICHI_CUSTOM_AGENTS', 'KIRO_CLI_BIN', 'LOCALAPPDATA',
  'MICHI_KIRO_ENGINE', 'MICHI_KIRO_PRELOAD_TOOLS',
] as const;
type EnvName = (typeof ENV)[number];

const bridge: AgentToolBridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };

const savedEnv = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});

/** michiKiroOptions and the factories over it loaded afresh under `env`, as at start-up. */
function loadFactories(env: Partial<Record<EnvName, string>>): typeof Factories & typeof KiroOptions {
  for (const key of ENV) delete process.env[key];
  Object.assign(process.env, env);
  const options = require.resolve('../src/agents/michiKiroOptions');
  const factories = require.resolve('../src/agents/runtimeFactories');
  delete require.cache[options];
  delete require.cache[factories];
  return { ...(require(options) as typeof KiroOptions), ...(require(factories) as typeof Factories) };
}

/** The options' values, with each function called now. */
function settings(options: ReturnType<typeof KiroOptions.kiroEnvOptions>) {
  const { approveTimeoutMs, customAgents, kiroCli, spawnEnv, preloadTools, ...values } = options;
  assert.equal(spawnEnv?.(), process.env, 'kiro-cli gets the environment of the moment it starts');
  return { ...values, approveTimeoutMs: approveTimeoutMs?.(), customAgents: customAgents?.(), kiroCli: kiroCli?.(),
    preloadTools: preloadTools?.() };
}

test('unset: the defaults KiroRuntime and AcpClient used', (t) => {
  const { kiroEnvOptions } = loadFactories({});
  assert.deepEqual(settings(kiroEnvOptions()), {
    processCap: 20, idleTtlMs: 300_000, warmPoolSize: 3, acpIdleTimeoutMs: 180_000, concurrencyCap: 100,
    approveTimeoutMs: 300_000, customAgents: false, kiroCli: { kiroCliBin: undefined, localAppData: undefined },
    preloadTools: true,
  });
});

test('set: parsed as before, malformed values included', (t) => {
  const { kiroEnvOptions } = loadFactories({
    MICHI_KIRO_MAX_PROCESSES: '7', MICHI_KIRO_IDLE_TTL_MS: '0', MICHI_KIRO_WARM_POOL_SIZE: '0', ACP_TIMEOUT_MS: '0',
    MICHI_KIRO_MAX_CONCURRENT: 'many', MICHI_APPROVE_TIMEOUT_MS: '1500', MICHI_CUSTOM_AGENTS: 'true',
    KIRO_CLI_BIN: '/opt/kiro-cli', LOCALAPPDATA: 'C:\\Local', MICHI_KIRO_PRELOAD_TOOLS: 'false',
  });
  assert.deepEqual(settings(kiroEnvOptions()), {
    processCap: 7, idleTtlMs: 0, warmPoolSize: 0, acpIdleTimeoutMs: 0, concurrencyCap: NaN,
    approveTimeoutMs: 1500, customAgents: false, kiroCli: { kiroCliBin: '/opt/kiro-cli', localAppData: 'C:\\Local' },
    preloadTools: false,
  });
  // Only the exact string turns preloading off, as kiroEnv read it.
  for (const raw of ['true', 'FALSE', '0', '']) {
    assert.equal(loadFactories({ MICHI_KIRO_PRELOAD_TOOLS: raw }).kiroEnvOptions().preloadTools?.(), true, raw);
  }
  for (const raw of ['-1', 'soon', 'Infinity']) {
    assert.equal(loadFactories({ ACP_TIMEOUT_MS: raw }).kiroEnvOptions().acpIdleTimeoutMs, 180_000, raw);
  }
  assert.equal(loadFactories({ MICHI_CUSTOM_AGENTS: '1' }).kiroEnvOptions().customAgents?.(), true);
});

test('each setting is read when it was before: module load, runtime creation, or use', (t) => {
  const { kiroEnvOptions } = loadFactories({});
  const set = (value: string) => Object.assign(process.env, Object.fromEntries(
    ['MICHI_KIRO_MAX_PROCESSES', 'MICHI_KIRO_IDLE_TTL_MS', 'MICHI_KIRO_WARM_POOL_SIZE', 'ACP_TIMEOUT_MS',
      'MICHI_KIRO_MAX_CONCURRENT', 'MICHI_APPROVE_TIMEOUT_MS', 'KIRO_CLI_BIN'].map((key) => [key, value])));
  set('1');
  const options = kiroEnvOptions();
  set('2');
  assert.deepEqual([options.processCap, options.idleTtlMs, options.warmPoolSize, options.acpIdleTimeoutMs], [20, 300_000, 3, 180_000]);
  assert.equal(options.concurrencyCap, 1);
  assert.deepEqual([options.approveTimeoutMs?.(), options.kiroCli?.().kiroCliBin], [2, '2']);
  process.env.MICHI_CUSTOM_AGENTS = '1';
  assert.equal(options.customAgents?.(), true);
  process.env.MICHI_KIRO_PRELOAD_TOOLS = 'false';
  assert.equal(options.preloadTools?.(), false, 'read at spawn, as kiroEnv read the spawn environment');
});

test('Kiro takes its engine from MICHI_KIRO_ENGINE; Crew stays v2 and ignores it', async (t) => {
  const deps = () => ({ bridge, mcpRegistry: fakeMcpRegistry() as any, mcpPort: 0, host: michiTestHost() });
  const runtimes: Array<{ shutdown(): Promise<void> }> = [];
  t.after(() => Promise.all(runtimes.map((runtime) => runtime.shutdown())));
  for (const [value, kiro, crew] of [[undefined, 'v2', 'v2'], ['v3', 'v3', 'v2']] as const) {
    const { RUNTIME_FACTORIES } = loadFactories(value ? { MICHI_KIRO_ENGINE: value } : {});
    const create = (id: string) => {
      const runtime = RUNTIME_FACTORIES.find((factory) => factory.id === id)!.create(deps());
      runtimes.push(runtime);
      return runtime.nativeEngine;
    };
    assert.equal(create('kiro'), kiro, `kiro under ${value}`);
    assert.equal(create('crew'), crew, `crew under ${value}`);
  }
  const { RUNTIME_FACTORIES } = loadFactories({ MICHI_KIRO_ENGINE: 'v4' });
  assert.throws(() => RUNTIME_FACTORIES.find((factory) => factory.id === 'kiro')!.create(deps()), /MICHI_KIRO_ENGINE must be v2 or v3/);
  runtimes.push(RUNTIME_FACTORIES.find((factory) => factory.id === 'crew')!.create(deps()));
});

test('a KiroRuntime without these options runs on the defaults, whatever the environment says', async (t) => {
  loadFactories({ MICHI_KIRO_MAX_PROCESSES: '1', MICHI_KIRO_MAX_CONCURRENT: '1', MICHI_KIRO_ENGINE: 'v3' });
  const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/michi-kiro-env-options', host: michiTestHost() });
  t.after(() => runtime.shutdown());
  const fields = runtime as unknown as Record<string, unknown>;
  assert.deepEqual(
    { engine: runtime.nativeEngine, processCap: fields.processCap, idleTtlMs: fields.idleTtlMs, warmPoolSize: fields.warmPoolSize, concurrencyCap: fields.concurrencyCap },
    { engine: 'v2', processCap: 20, idleTtlMs: 300_000, warmPoolSize: 3, concurrencyCap: 100 },
  );
});

test('Crew\'s adapter and App locations are read from the environment at each call', (t) => {
  const keys = ['MICHI_CREW_ACP_BIN', 'KIROCREW_HOME', 'MICHI_CREW_APP'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  const { crewEnvOptions } = loadFactories({});
  for (const key of keys) delete process.env[key];
  assert.deepEqual(crewEnvOptions(), { acpBinOverride: undefined, kirocrewHome: undefined, appName: undefined });
  Object.assign(process.env, { MICHI_CREW_ACP_BIN: ' /opt/crew-acp ', KIROCREW_HOME: '/srv/crew', MICHI_CREW_APP: 'other-app' });
  assert.deepEqual(crewEnvOptions(), { acpBinOverride: ' /opt/crew-acp ', kirocrewHome: '/srv/crew', appName: 'other-app' });
});
