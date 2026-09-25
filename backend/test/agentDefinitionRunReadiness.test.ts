import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeProfileV1 } from 'michi-shared';
import { RuntimeRunAdapterRegistry } from '../src/agents/runs/runtimeRunAdapterRegistry';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';
import { CodexRunAdapter } from '../src/agents/runs/codexRunAdapter';
import type { RuntimeProfileReadiness } from '../src/services/agentDefinitionService';

// ---------------------------------------------------------------------------
// Fake RuntimeProfileReadiness that checks both runtime AND adapter
// ---------------------------------------------------------------------------

/** Mirrors the production RegisteredRuntimeReadiness with a fake runtime set. */
function createFakeReadiness(
  registeredRuntimes: ReadonlySet<string>,
  adapterRegistry: RuntimeRunAdapterRegistry,
): RuntimeProfileReadiness {
  return {
    validate(profile: RuntimeProfileV1): void {
      if (!registeredRuntimes.has(profile.runtimeId)) {
        throw new Error(`runtime ${profile.runtimeId} is not available`);
      }
      if (!adapterRegistry.has(profile.runtimeId)) {
        const supported = adapterRegistry.supportedRuntimeIds();
        const list = supported.length > 0 ? supported.join(', ') : '(none)';
        throw new Error(
          `runtime ${profile.runtimeId} does not have a Run adapter; `
          + `runtimes with Run adapters are ${list}`,
        );
      }
    },
  };
}

function profile(runtimeId: string): RuntimeProfileV1 {
  return { version: 1, runtimeId, providerId: null, modelId: null, modeId: null, reasoning: null };
}

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

test('registry registers all four adapters and retrieves them by id', () => {
  const registry = new RuntimeRunAdapterRegistry([
    new PiRunAdapter(), new ClaudeRunAdapter(), new KiroRunAdapter(), new CodexRunAdapter(),
  ]);
  assert.equal(registry.has('pi'), true);
  assert.equal(registry.has('claude'), true);
  assert.equal(registry.has('kiro'), true);
  assert.equal(registry.has('codex'), true);
  assert.equal(registry.has('nonexistent'), false);
  assert.deepEqual(registry.supportedRuntimeIds(), ['pi', 'claude', 'kiro', 'codex']);
  assert.equal(registry.all().length, 4);
});

test('registry rejects duplicate adapter registration', () => {
  assert.throws(
    () => new RuntimeRunAdapterRegistry([new PiRunAdapter(), new PiRunAdapter()]),
    /Duplicate Run adapter for runtime pi/,
  );
});

test('registry get returns undefined for unregistered runtimes', () => {
  const registry = new RuntimeRunAdapterRegistry([new PiRunAdapter()]);
  assert.equal(registry.get('pi')?.runtimeId, 'pi');
  assert.equal(registry.get('claude'), undefined);
});

test('empty registry reports no supported runtimes', () => {
  const registry = new RuntimeRunAdapterRegistry();
  assert.deepEqual(registry.supportedRuntimeIds(), []);
  assert.equal(registry.has('pi'), false);
});

// ---------------------------------------------------------------------------
// Adapter metadata tests
// ---------------------------------------------------------------------------

test('Pi adapter declares allowlist tool mode and native steering', () => {
  const adapter = new PiRunAdapter();
  assert.equal(adapter.runtimeId, 'pi');
  assert.equal(adapter.nativeToolMode, 'allowlist');
  assert.equal(adapter.steering, 'native');
  assert.equal(adapter.supportsNativeResume, false);
});

test('Claude adapter declares allowlist tool mode and native steering', () => {
  const adapter = new ClaudeRunAdapter();
  assert.equal(adapter.runtimeId, 'claude');
  assert.equal(adapter.nativeToolMode, 'allowlist');
  assert.equal(adapter.steering, 'native');
  assert.equal(adapter.supportsNativeResume, true);
});

test('Kiro adapter declares runtime_default tool mode and native steering', () => {
  const adapter = new KiroRunAdapter();
  assert.equal(adapter.runtimeId, 'kiro');
  assert.equal(adapter.nativeToolMode, 'runtime_default');
  assert.equal(adapter.steering, 'native');
  assert.equal(adapter.immediateSteering, 'next_turn');
  assert.equal(adapter.supportsNativeResume, true);
});

test('Codex adapter declares runtime_default tool mode and native steering', () => {
  const adapter = new CodexRunAdapter();
  assert.equal(adapter.runtimeId, 'codex');
  assert.equal(adapter.nativeToolMode, 'runtime_default');
  assert.equal(adapter.steering, 'native');
  assert.equal(adapter.supportsNativeResume, true);
});

// ---------------------------------------------------------------------------
// Definition readiness — runtime + adapter required
// ---------------------------------------------------------------------------

test('readiness passes when both runtime and adapter are registered', () => {
  const runtimes = new Set(['pi', 'claude', 'kiro', 'codex']);
  const registry = new RuntimeRunAdapterRegistry([
    new PiRunAdapter(), new ClaudeRunAdapter(), new KiroRunAdapter(), new CodexRunAdapter(),
  ]);
  const readiness = createFakeReadiness(runtimes, registry);
  // All four should pass
  assert.doesNotThrow(() => readiness.validate(profile('pi'), 'owner-1'));
  assert.doesNotThrow(() => readiness.validate(profile('claude'), 'owner-1'));
  assert.doesNotThrow(() => readiness.validate(profile('kiro'), 'owner-1'));
  assert.doesNotThrow(() => readiness.validate(profile('codex'), 'owner-1'));
});

test('readiness error message lists all supported adapter runtimes', () => {
  const runtimes = new Set(['pi', 'claude', 'kiro', 'codex', 'experimental']);
  const registry = new RuntimeRunAdapterRegistry([
    new PiRunAdapter(), new ClaudeRunAdapter(), new KiroRunAdapter(), new CodexRunAdapter(),
  ]);
  const readiness = createFakeReadiness(runtimes, registry);
  try {
    readiness.validate(profile('experimental'), 'owner-1');
    assert.fail('expected validation to throw');
  } catch (err) {
    const message = (err as Error).message;
    assert.match(message, /experimental/);
    assert.match(message, /pi/);
    assert.match(message, /claude/);
    assert.match(message, /kiro/);
    assert.match(message, /codex/);
  }
});

// ---------------------------------------------------------------------------
// Adapter assertCompatible — negative cases
// ---------------------------------------------------------------------------

test('Kiro adapter rejects wrong runtime id', () => {
  const adapter = new KiroRunAdapter();
  const fakeRuntime = { id: 'pi', capabilities: { nativeResume: true } };
  assert.throws(
    () => adapter.assertCompatible(fakeRuntime as never),
    /Kiro Run adapter cannot execute runtime pi/,
  );
});

test('Kiro adapter rejects runtime without nativeResume', () => {
  const adapter = new KiroRunAdapter();
  const fakeRuntime = { id: 'kiro', capabilities: { nativeResume: false } };
  assert.throws(
    () => adapter.assertCompatible(fakeRuntime as never),
    /incompatible.*native-resume/,
  );
});

test('Codex adapter rejects wrong runtime id', () => {
  const adapter = new CodexRunAdapter();
  const fakeRuntime = { id: 'claude', capabilities: { nativeResume: true } };
  assert.throws(
    () => adapter.assertCompatible(fakeRuntime as never),
    /Codex Run adapter cannot execute runtime claude/,
  );
});

test('Codex adapter rejects runtime without nativeResume', () => {
  const adapter = new CodexRunAdapter();
  const fakeRuntime = { id: 'codex', capabilities: { nativeResume: false } };
  assert.throws(
    () => adapter.assertCompatible(fakeRuntime as never),
    /incompatible.*native-resume/,
  );
});

test('Pi adapter rejects wrong runtime id', () => {
  const adapter = new PiRunAdapter();
  const fakeRuntime = { id: 'kiro', capabilities: { models: true, reasoning: true } };
  assert.throws(
    () => adapter.assertCompatible(fakeRuntime as never),
    /Pi Run adapter cannot execute runtime kiro/,
  );
});

// ---------------------------------------------------------------------------
// Fallback chain validation
// ---------------------------------------------------------------------------

test('readiness validates every fallback profile, not just the primary', () => {
  const runtimes = new Set(['pi', 'kiro']);
  const registry = new RuntimeRunAdapterRegistry([new PiRunAdapter()]);
  const readiness = createFakeReadiness(runtimes, registry);
  // Primary pi passes, but fallback kiro should fail (no adapter)
  assert.doesNotThrow(() => readiness.validate(profile('pi'), 'owner-1'));
  assert.throws(
    () => readiness.validate(profile('kiro'), 'owner-1'),
    /does not have a Run adapter/,
  );
});
