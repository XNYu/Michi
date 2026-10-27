/**
 * Michi's environment settings for the Claude adapter (michiClaudeOptions.ts):
 * defaults, parsing and the values that fall back, and when each is read.
 * Rows written against the parsing the adapter did before the move.
 */
import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLAUDE_CLI_FLAGS, DEFAULT_CLAUDE_LIMITS,
} from 'michi-runtime/internal/adapters/claude/claudeAdapterOptions';
import { michiClaudeAdapterOptions } from '../src/agents/michiClaudeOptions';
import * as agentConfig from '../src/services/agentConfig';
import * as assistantPolicy from '../src/assistant/policy';
import * as claudeHostText from '../src/agents/hostText/claude';
import { michiTestHost } from './helpers/michiTestHost';

const KEYS = [
  'MICHI_CLAUDE_MAX_CONCURRENT', 'MICHI_CLAUDE_POOL_DISABLED', 'MICHI_CLAUDE_POOL_SESSIONS_PER_CWD',
  'MICHI_CLAUDE_WAIT_FOR_WARM', 'MICHI_CLAUDE_INIT_TIMEOUT_MS', 'MICHI_APPROVE_TIMEOUT_MS',
  'MICHI_CLAUDE_DISPOSE_TERM_TIMEOUT_MS', 'MICHI_CLAUDE_DISPOSE_KILL_TIMEOUT_MS', 'MICHI_CLAUDE_BARE',
  'MICHI_CLAUDE_STRICT_MCP', 'MICHI_CLAUDE_SUBAGENT_TEXT', 'MICHI_CLAUDE_HUMAN_ORIGIN',
  'MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC', 'CLAUDE_CLI_BIN',
] as const;
type Key = typeof KEYS[number];

/** This process's values, put back when the file is done. */
const ORIGINAL = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
after(() => {
  for (const key of KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

/** Clears every setting above, then applies `values` (undefined: unset). */
function withEnv(values: Partial<Record<Key, string | undefined>> = {}): void {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
}

const options = () => michiClaudeAdapterOptions(michiTestHost());

test('limits default to the adapter\'s old constants', () => {
  withEnv();
  assert.deepEqual(options().limits, {
    maxConcurrent: 15,
    pool: { disabled: false, sessionsPerCwd: 2, waitForWarm: true },
    initTimeoutMs: 60_000, approveTimeoutMs: 300_000, disposeTermTimeoutMs: 2000, disposeKillTimeoutMs: 1000,
  });
});

test("with no setting, the limits and CLI switches are the package's defaults", () => {
  withEnv();
  const built = options();
  assert.deepEqual(built.limits, DEFAULT_CLAUDE_LIMITS);
  assert.deepEqual(built.cli(), DEFAULT_CLAUDE_CLI_FLAGS);
});

test('limits take integer overrides as parseInt reads them', () => {
  withEnv({
    MICHI_CLAUDE_MAX_CONCURRENT: '3', MICHI_CLAUDE_POOL_SESSIONS_PER_CWD: '4', MICHI_APPROVE_TIMEOUT_MS: '1500',
    MICHI_CLAUDE_DISPOSE_TERM_TIMEOUT_MS: '50', MICHI_CLAUDE_DISPOSE_KILL_TIMEOUT_MS: '25ms',
  });
  const { limits } = options();
  assert.equal(limits.maxConcurrent, 3);
  assert.equal(limits.pool.sessionsPerCwd, 4);
  assert.equal(limits.approveTimeoutMs, 1500);
  assert.equal(limits.disposeTermTimeoutMs, 50);
  assert.equal(limits.disposeKillTimeoutMs, 25, 'parseInt stops at the first non-digit');
  withEnv({ MICHI_CLAUDE_MAX_CONCURRENT: 'many' });
  assert.ok(Number.isNaN(options().limits.maxConcurrent), 'no fallback for an unparsable cap, as before');
});

test('the pool is disabled only by exactly 1', () => {
  for (const [value, disabled] of [[undefined, false], ['1', true], ['true', false], ['0', false], ['', false]] as const) {
    withEnv({ MICHI_CLAUDE_POOL_DISABLED: value });
    assert.equal(options().limits.pool.disabled, disabled, String(value));
  }
});

test('waiting for a warm process stays on unless the flag says no', () => {
  const rows: Array<[string | undefined, boolean]> = [
    [undefined, true], ['', true], ['1', true], ['yes', true], ['on', true],
    ['0', false], ['false', false], ['off', false], ['no', false], [' OFF ', false], ['False', false],
  ];
  for (const [value, waitForWarm] of rows) {
    withEnv({ MICHI_CLAUDE_WAIT_FOR_WARM: value });
    assert.equal(options().limits.pool.waitForWarm, waitForWarm, JSON.stringify(value));
  }
});

test('the native restore deadline accepts a positive integer up to 2^31 - 1, else 60 s', () => {
  const rows: Array<[string | undefined, number]> = [
    [undefined, 60_000], ['1250', 1250], ['2147483647', 2_147_483_647], ['2147483648', 60_000],
    ['0', 60_000], ['-5', 60_000], ['1.5', 60_000], ['invalid', 60_000], ['', 60_000],
  ];
  for (const [value, initTimeoutMs] of rows) {
    withEnv({ MICHI_CLAUDE_INIT_TIMEOUT_MS: value });
    assert.equal(options().limits.initTimeoutMs, initTimeoutMs, JSON.stringify(value));
  }
});

test('CLI switches: bare and strict MCP only on 1, subagent text and human origin off only on 0', () => {
  const rows: Array<[string | undefined, { on: boolean; off: boolean }]> = [
    [undefined, { on: false, off: true }], ['1', { on: true, off: true }], ['0', { on: false, off: false }],
    ['true', { on: false, off: true }], ['false', { on: false, off: true }], ['', { on: false, off: true }],
  ];
  for (const [value, expected] of rows) {
    withEnv({
      MICHI_CLAUDE_BARE: value, MICHI_CLAUDE_STRICT_MCP: value,
      MICHI_CLAUDE_SUBAGENT_TEXT: value, MICHI_CLAUDE_HUMAN_ORIGIN: value,
    });
    assert.deepEqual(options().cli(), {
      bare: expected.on, strictMcp: expected.on, forwardSubagentText: expected.off, humanOrigin: expected.off,
    }, JSON.stringify(value));
  }
});

test('the Stop-hook POC turns on for 1, true, yes and on, in any case and spacing', () => {
  const rows: Array<[string | undefined, boolean]> = [
    [undefined, false], ['1', true], ['true', true], ['YES', true], [' on ', true],
    ['0', false], ['off', false], ['enabled', false], ['', false],
  ];
  for (const [value, enabled] of rows) {
    withEnv({ MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC: value });
    assert.equal(options().followUpsHookPoc(), enabled, JSON.stringify(value));
  }
});

test('limits are read once, with the options; the other settings at every call', () => {
  withEnv();
  const built = options();
  process.env.MICHI_CLAUDE_INIT_TIMEOUT_MS = '1250';
  process.env.MICHI_CLAUDE_BARE = '1';
  process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = '1';
  process.env.CLAUDE_CLI_BIN = '/fixture/claude';
  assert.equal(built.limits.initTimeoutMs, 60_000);
  assert.equal(built.cli().bare, true);
  assert.equal(built.followUpsHookPoc(), true);
  assert.equal(built.binaryPath(), '/fixture/claude');
  // The child's environment is the live one (compared by identity; never printed).
  assert.ok(built.spawnEnv() === process.env, 'spawnEnv is process.env itself');
});

test("Michi's options carry the credential notice as their stderr warning", () => {
  withEnv();
  const { stderrWarning } = options();
  assert.deepEqual(stderrWarning?.('awsCredentialExport did not return a valid value'), {
    source: 'auth', category: 'configuration',
    message: 'AWS credentials unavailable. Refresh your credentials in your terminal, then retry.',
  });
  assert.equal(stderrWarning?.('some other stderr line'), undefined);
  assert.equal(options().modelCatalog, undefined, 'no live catalog unless the factory passes one');
});

/** Stubs `target[name]`, calls `invoke`, and checks the stub got exactly `args` and its value came back. */
function expectDelegation(t: TestContext, target: object, name: string, invoke: () => unknown, args: unknown[]): void {
  const result = Symbol(name);
  const stub = t.mock.method(target as Record<string, (...a: any[]) => any>, name, () => result);
  assert.equal(invoke(), result);
  assert.equal(stub.mock.callCount(), 1);
  assert.deepEqual(stub.mock.calls[0].arguments, args);
}

test('configDir → agentConfig.resolveClaudeConfigDir, at every call', (t) => {
  const { configDir } = options();
  expectDelegation(t, agentConfig, 'resolveClaudeConfigDir', () => configDir!(), [undefined]);
  t.mock.restoreAll();
  expectDelegation(t, agentConfig, 'resolveClaudeConfigDir', () => configDir!('u1'), ['u1']);
  t.mock.restoreAll();
  expectDelegation(t, agentConfig, 'resolveClaudeConfigDir', () => configDir!(null), [undefined]);
});

test("a restricted session's tool verdict → assistantPolicy.claudeAssistantApproval", (t) => {
  const { restrictedToolApproval } = options();
  expectDelegation(t, assistantPolicy, 'claudeAssistantApproval', () => restrictedToolApproval!('list_threads'), ['list_threads']);
  t.mock.restoreAll();
  expectDelegation(t, assistantPolicy, 'claudeAssistantApproval', () => restrictedToolApproval!(null), [null]);
  t.mock.restoreAll();
  assert.equal(restrictedToolApproval!('list_threads'), 'allow');
  assert.equal(restrictedToolApproval!('Bash'), 'deny');
  assert.equal(restrictedToolApproval!(null), 'deny');
});

test('the Stop-hook POC instruction → hostText/claude.buildClaudeFollowUpsHookPocInstruction', (t) => {
  const { hostText } = options();
  expectDelegation(t, claudeHostText, 'buildClaudeFollowUpsHookPocInstruction',
    () => hostText!.followUpsHookPocInstruction!('hook-tool'), ['hook-tool']);
  t.mock.restoreAll();
  for (const mode of ['sentinel', 'hook-tool'] as const) {
    assert.equal(hostText!.followUpsHookPocInstruction!(mode), claudeHostText.buildClaudeFollowUpsHookPocInstruction(mode));
  }
});
