import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLAUDE_CLI_FLAGS, DEFAULT_CLAUDE_LIMITS, claudeAdapterOptions,
  type ClaudeAdapterOptions, type ClaudeLimits,
} from '../src/adapters/claude/index';
import { createDefaultHost } from '../src/core/defaultHost';

const host = createDefaultHost({ logLevel: 'silent' });
const spawnEnv = (): NodeJS.ProcessEnv => ({ PATH: '/bin' });
const OPTIONAL = ['modelCatalog', 'configDir', 'stderrWarning', 'restrictedToolApproval', 'hostText'] as const;

describe('Claude adapter defaults', () => {
  it('pins the default limits and CLI switches', () => {
    assert.deepEqual(DEFAULT_CLAUDE_LIMITS, {
      maxConcurrent: 15,
      pool: { disabled: false, sessionsPerCwd: 2, waitForWarm: true },
      initTimeoutMs: 60_000, approveTimeoutMs: 300_000, disposeTermTimeoutMs: 2000, disposeKillTimeoutMs: 1000,
    });
    assert.deepEqual(DEFAULT_CLAUDE_CLI_FLAGS, { bare: false, strictMcp: false, forwardSubagentText: true, humanOrigin: true });
  });

  it('freezes both constants, the pool included', () => {
    assert.ok(Object.isFrozen(DEFAULT_CLAUDE_LIMITS));
    assert.ok(Object.isFrozen(DEFAULT_CLAUDE_LIMITS.pool));
    assert.ok(Object.isFrozen(DEFAULT_CLAUDE_CLI_FLAGS));
    // @ts-expect-error: the pool's members are read-only in the type as well.
    assert.throws(() => { DEFAULT_CLAUDE_LIMITS.pool.disabled = true; }, TypeError);
  });

  it('defaults every required member from the host and the environment alone', () => {
    const options = claudeAdapterOptions({ host, spawnEnv });
    assert.equal(options.host, host);
    assert.equal(options.spawnEnv, spawnEnv);
    assert.deepEqual(options.limits, DEFAULT_CLAUDE_LIMITS);
    assert.deepEqual(options.cli(), DEFAULT_CLAUDE_CLI_FLAGS);
    assert.equal(options.binaryPath(), undefined);
    assert.equal(options.followUpsHookPoc(), false);
  });

  it('hands out copies of the defaults, so changing them leaves the constants alone', () => {
    const options = claudeAdapterOptions({ host, spawnEnv });
    assert.notEqual(options.limits, DEFAULT_CLAUDE_LIMITS);
    assert.notEqual(options.limits.pool, DEFAULT_CLAUDE_LIMITS.pool);
    options.limits.maxConcurrent = 1;
    options.limits.pool.disabled = true;
    const flags = options.cli();
    assert.notEqual(flags, DEFAULT_CLAUDE_CLI_FLAGS);
    assert.notEqual(options.cli(), flags, 'a new copy at each call');
    flags.bare = true;
    assert.equal(DEFAULT_CLAUDE_LIMITS.maxConcurrent, 15);
    assert.equal(DEFAULT_CLAUDE_LIMITS.pool.disabled, false);
    assert.equal(DEFAULT_CLAUDE_CLI_FLAGS.bare, false);
    assert.deepEqual(claudeAdapterOptions({ host, spawnEnv }).limits, DEFAULT_CLAUDE_LIMITS);
  });

  it('gives a required member set to undefined its default', () => {
    const options = claudeAdapterOptions({
      host, spawnEnv, limits: undefined, cli: undefined, binaryPath: undefined, followUpsHookPoc: undefined,
    });
    assert.deepEqual(options.limits, DEFAULT_CLAUDE_LIMITS);
    assert.deepEqual(options.cli(), DEFAULT_CLAUDE_CLI_FLAGS);
    assert.equal(options.binaryPath(), undefined);
    assert.equal(options.followUpsHookPoc(), false);
  });

  it('leaves out each optional member not given, or given as undefined', () => {
    for (const options of [
      claudeAdapterOptions({ host, spawnEnv }),
      claudeAdapterOptions({
        host, spawnEnv, modelCatalog: undefined, configDir: undefined, stderrWarning: undefined,
        restrictedToolApproval: undefined, hostText: undefined,
      }),
    ]) {
      for (const key of OPTIONAL) assert.equal(Object.hasOwn(options, key), false, key);
    }
  });

  it('passes every given member through unchanged', () => {
    const limits: ClaudeLimits = {
      maxConcurrent: 3, pool: { disabled: true, sessionsPerCwd: 1, waitForWarm: false },
      initTimeoutMs: 1250, approveTimeoutMs: 1500, disposeTermTimeoutMs: 50, disposeKillTimeoutMs: 25,
    };
    const given: ClaudeAdapterOptions = {
      host, spawnEnv, limits,
      modelCatalog: {},
      configDir: () => 'claude-profile',
      binaryPath: () => 'claude-bin',
      cli: () => ({ bare: true, strictMcp: true, forwardSubagentText: false, humanOrigin: false }),
      followUpsHookPoc: () => true,
      stderrWarning: () => undefined,
      restrictedToolApproval: () => 'allow',
      hostText: {},
    };
    const options = claudeAdapterOptions(given);
    assert.deepEqual(Object.keys(options).sort(), Object.keys(given).sort());
    for (const key of Object.keys(given) as Array<keyof ClaudeAdapterOptions>) assert.equal(options[key], given[key], key);
  });
});
