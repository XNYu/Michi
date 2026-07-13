import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityRuntime, parseModelCatalog } from '../src/agents/antigravity/AntigravityRuntime';
import type { ModelInfo } from '../src/agents/types';
import type { RuntimeModelCache } from '../src/agents/runtimeModelCache';
import { __resetRuntimeDeps, configureRuntimeDeps } from '../src/agents/runtimeDeps';
import { getEnabledFactories } from '../src/agents/runtimeFactories';
import { normalizeLegacyRuntimeId } from '../src/services/agentConfig';
import {
  ensureAntigravityCustomization,
  warmAntigravityCustomization,
} from '../src/agents/antigravity/antigravityCustomization';

const FAKE_AGY = path.join(__dirname, 'fixtures', 'fakeAntigravity.js');
let dataDir: string;

beforeEach(() => {
  fs.chmodSync(FAKE_AGY, 0o755);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-runtime-'));
  __resetRuntimeDeps();
  configureRuntimeDeps({
    dataDir,
    historyStore: {
      getNode: () => null,
      listMessages: () => [],
      getWorkspace: () => null,
      getWorkspaceInstructions: () => null,
      hasGrant: () => false,
      grantPermission: () => {},
    } as any,
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'antigravity' }) as any,
      resolveModel: () => '',
      resolveReasoning: () => undefined,
    },
  });
});

afterEach(() => {
  __resetRuntimeDeps();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('AntigravityRuntime capabilities', () => {
  test('advertises only the public AGY surface', () => {
    const runtime = new AntigravityRuntime({ binaryPath: FAKE_AGY });
    assert.equal(runtime.id, 'antigravity');
    assert.equal(runtime.label, 'Antigravity');
    assert.equal(runtime.capabilities.models, true);
    assert.equal(runtime.capabilities.modes, true);
    assert.equal(runtime.capabilities.nativeResume, true);
    assert.equal(runtime.capabilities.permissions, false);
    assert.equal(runtime.capabilities.warmSessions, false);
    assert.equal(runtime.capabilities.saveContext, false);
    assert.equal(runtime.capabilities.spawnBranches, false);
  });

  test('lists the supported review, edit, plan, and sandbox modes', async () => {
    const runtime = new AntigravityRuntime({ binaryPath: FAKE_AGY });
    assert.deepEqual(
      (await runtime.listModes('node')).map((mode) => mode.id),
      ['default', 'accept-edits', 'plan', 'sandbox'],
    );
  });
});

describe('Antigravity custom agent', () => {
  test('materializes stable Michi metadata instructions outside the user workspace', () => {
    const customization = ensureAntigravityCustomization(dataDir);
    assert.equal(customization.agentName, 'michi');
    assert.ok(customization.rootDir.startsWith(dataDir));
    const content = fs.readFileSync(customization.agentFile, 'utf8');
    assert.match(content, /^---\nname: michi\n/m);
    assert.match(content, /\[TITLE: 4-8 word summary\]/);
    assert.match(content, /\[FOLLOW-UP 1\/3:/);
    assert.doesNotMatch(content, /____michi_internal____ask_user/);
  });

  test('warms AGY customization discovery without creating a conversation', async () => {
    const customization = ensureAntigravityCustomization(dataDir);
    await warmAntigravityCustomization(FAKE_AGY, customization);
  });
});

describe('AntigravityRuntime model catalog', () => {
  test('parses unique line-oriented labels and marks the first default', () => {
    const models = parseModelCatalog('Model A\nModel B\nModel A\n');
    assert.deepEqual(models, [
      { id: 'Model A', label: 'Model A', isDefault: true },
      { id: 'Model B', label: 'Model B', isDefault: undefined },
    ]);
  });

  test('returns a cached snapshot immediately and refreshes it in the background', async () => {
    const cached: ModelInfo[] = [{ id: 'Cached', label: 'Cached' }];
    let saved: ModelInfo[] | null = null;
    const cache: RuntimeModelCache = {
      load: () => cached,
      save: (_runtimeId, models) => { saved = models; },
    };
    const runtime = new AntigravityRuntime({ binaryPath: FAKE_AGY, modelCache: cache });
    assert.deepEqual(await runtime.listModels(), cached);
    const fresh = await runtime.refreshModels();
    assert.equal(fresh[0].id, 'Gemini 3.5 Flash (Medium)');
    assert.deepEqual(saved, fresh);
  });
});

describe('legacy Gemini configuration compatibility', () => {
  test('normalizes the removed runtime id', () => {
    assert.equal(normalizeLegacyRuntimeId('gemini'), 'antigravity');
    assert.equal(normalizeLegacyRuntimeId('claude'), 'claude');
  });

  test('MICHI_ENABLED_RUNTIMES=gemini enables Antigravity', () => {
    const previous = process.env.MICHI_ENABLED_RUNTIMES;
    process.env.MICHI_ENABLED_RUNTIMES = 'gemini';
    try {
      assert.deepEqual(getEnabledFactories().map((factory) => factory.id), ['antigravity']);
    } finally {
      if (previous === undefined) delete process.env.MICHI_ENABLED_RUNTIMES;
      else process.env.MICHI_ENABLED_RUNTIMES = previous;
    }
  });
});
