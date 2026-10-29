import { restrictedChatProfile } from './helpers/restrictedChatProfile';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createClaudeSdkTransport, type ClaudeSdkTransportOptions } from 'michi-runtime/internal/adapters/claude/claudeSdkTransport';
import { michiTestHost } from './helpers/michiTestHost';

function harness(t: TestContext) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  t.mock.method(require('michi-runtime/internal/adapters/claude/claudeBinary'), 'preflightClaudeAuth', () => {});
  t.mock.method(require('michi-runtime/internal/adapters/claude/claudeBinary'), 'findClaudeBinary', () => '/fixture/claude');
  t.mock.method(require('../src/agents/processTree'), 'spawnAgentProcess', () => child);
  let options: any;
  let input: AsyncIterable<any>;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const errors: Error[] = [];
  const sdk: any = { query(args: any) {
    options = args.options; input = args.prompt;
    options.spawnClaudeCodeProcess({ command: '/fixture/claude', args: [], cwd: '/tmp', env: {} });
    return {
      initializationResult: async () => ({}),
      close: finish,
      async *[Symbol.asyncIterator]() { await finished; },
    };
  } };
  return {
    child,
    get options() { return options; },
    get input() { return input!; }, errors,
    async create(overrides: Partial<ClaudeSdkTransportOptions> = {}) {
      const transport = await createClaudeSdkTransport({
        cwd: '/tmp', permissionMode: 'default', mcpConfigInline: '{"mcpServers":{}}',
        onMessage: () => {}, onStderr: () => {}, onError: error => errors.push(error),
        authorize: async (_name, updatedInput) => ({ behavior: 'allow', updatedInput }),
        preToolUse: async () => undefined, log: michiTestHost().observability.log, spawnEnv: process.env, sdk, ...overrides,
      });
      t.after(() => transport.close());
      return transport;
    },
  };
}

test('restricted SDK sessions retain mandatory host hooks before native auto-approval', async t => {
  const h = harness(t);
  const calls: unknown[][] = [];
  await h.create({ restricted: true, bare: true, tools: ['Read'],
    settingsInline: '{"permissions":{"allow":["Bash(*)"]},"disableAllHooks":true}',
    preToolUse: async (...args) => { calls.push(args); return { behavior: 'deny', message: 'Run policy denied' }; },
  });
  assert.deepEqual(h.options.tools, ['Read']);
  assert.equal(h.options.allowedTools, undefined, 'tool exposure must not become auto-approval');
  assert.deepEqual(h.options.settingSources, []);
  assert.equal(h.options.settings.disableAllHooks, false);
  assert.equal(h.options.extraArgs.bare, undefined, 'bare would suppress mandatory hooks');
  assert.equal(h.options.allowDangerouslySkipPermissions, false);
  const controller = new AbortController();
  const result = await h.options.hooks.PreToolUse[0].hooks[0]({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'touch forbidden' }, tool_use_id: 'tool-1',
  }, undefined, { signal: controller.signal });
  assert.equal(calls[0][0], 'Bash');
  assert.equal(calls[0][2], 'tool-1');
  assert.equal(calls[0][3], controller.signal);
  assert.deepEqual(result.hookSpecificOutput, {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Run policy denied',
  });
});

test('Run policy remains enabled without an explicit tool exposure list', async t => {
  const h = harness(t);
  await h.create({ restricted: true, bare: true });
  assert.equal(h.options.extraArgs.bare, undefined);
  assert.deepEqual(h.options.settingSources, []);
  assert.equal(h.options.settings.disableAllHooks, false);
  assert.equal(h.options.allowDangerouslySkipPermissions, false);
});

test('SDK permission callbacks carry the native tool ID and abort signal', async t => {
  const h = harness(t);
  const calls: unknown[][] = [];
  await h.create({ authorize: async (...args) => { calls.push(args); return { behavior: 'deny', message: 'cancelled' }; } });
  const controller = new AbortController();
  controller.abort();
  const result = await h.options.canUseTool('AskUserQuestion', { questions: [] }, {
    toolUseID: 'question-1', signal: controller.signal,
  });
  assert.deepEqual(calls, [['AskUserQuestion', { questions: [] }, 'question-1', controller.signal]]);
  assert.equal(result.behavior, 'deny');
});

test('restricted provider settings retain auth without loading user hooks or putting credentials in argv', async t => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-sdk-settings-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    awsCredentialExport: 'credential-fixture', hooks: { PreToolUse: ['unsafe'] },
    permissions: { allow: ['Bash(*)'] }, env: { AWS_PROFILE: 'fixture-profile', UNRELATED_VALUE: 'omit' },
  }));
  const h = harness(t);
  await h.create({ configDir, restricted: true, bare: true });
  assert.equal(h.options.settings.awsCredentialExport, 'credential-fixture');
  assert.equal(h.options.settings.hooks, undefined);
  assert.equal(h.options.settings.permissions, undefined);
  assert.equal(h.options.settings.env, undefined);
  assert.equal(h.options.env.AWS_PROFILE, 'fixture-profile');
  assert.equal(h.options.env.UNRELATED_VALUE, undefined);
  assert.equal(h.options.env.CLAUDE_CONFIG_DIR, configDir);
});

test('a malformed settings file carries nothing over and is logged without its contents', async t => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-sdk-bad-settings-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(configDir, 'settings.json'), '{"env": {"ANTHROPIC_API_KEY": "sk-secret-fixture"}, oops');
  const warnings: unknown[][] = [];
  t.mock.method(require('../src/services/logger').log, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const h = harness(t);
  await h.create({ configDir, restricted: true, bare: true });
  assert.deepEqual(h.options.settings, { disableAllHooks: false });
  assert.equal(h.options.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /sk-secret-fixture|oops/);
  assert.match(JSON.stringify(warnings[0][2]), /SyntaxError/);
});

test('SDK input remains ordered and closing releases a pending input reader', async t => {
  const h = harness(t), transport = await h.create();
  const iterator = h.input[Symbol.asyncIterator]();
  const message: any = { type: 'user', message: { role: 'user', content: 'hello' }, session_id: '', parent_tool_use_id: null };
  transport.send(message);
  assert.deepEqual((await iterator.next()).value, message);
  const pending = iterator.next();
  transport.close();
  assert.equal((await pending).done, true);
  assert.throws(() => transport.send(message), /input is closed/);
  assert.deepEqual(h.errors, []);
});

test('synchronous SDK startup failure retires the process before Session owns it', async t => {
  const h = harness(t);
  Object.assign(h.child, { pid: 12_345 });
  const signals: unknown[][] = [];
  t.mock.method(require('../src/agents/processTree'), 'killProcessTree', (...args: unknown[]) => signals.push(args));
  await assert.rejects(h.create({ sdk: { query: ((args: any) => {
    args.options.spawnClaudeCodeProcess({ command: '/fixture/claude', args: [], cwd: '/tmp', env: {} });
    throw new Error('startup failed after spawning');
  }) as any } }), /startup failed after spawning/);
  assert.deepEqual(signals, [[12_345, 'SIGKILL']]);
});

/** The options ClaudeSession hands the transport for the ⌘J assistant (ClaudeSession.doSpawn). */
function assistantTransportOptions(): Partial<ClaudeSdkTransportOptions> {
  const { claudeSpawnPolicy, assistantToolProfile } = require('../src/assistant/policy') as typeof import('../src/assistant/policy');
  const policy = claudeSpawnPolicy({ ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: restrictedChatProfile() });
  return {
    tools: [...policy.tools!], disallowedTools: [...policy.disallowedTools!], restricted: true,
    isolateSettings: policy.isolateSettings, restrictedMode: policy.restrictedMode,
    strictMcpConfig: policy.strictMcpConfig, permissionMode: policy.permissionMode,
    mcpConfigInline: JSON.stringify({ mcpServers: { __michi_internal__: { type: 'http', url: 'http://127.0.0.1:1/mcp/slot', alwaysLoad: true } } }),
  };
}

test("the assistant's SDK options: no built-in tools, deny rules, no user settings, only Michi's MCP, never bypass", async t => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-sdk-assistant-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  // A user configuration that would widen an ordinary chat.
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    model: 'opus', permissions: { allow: ['Bash(*)', 'Write'], defaultMode: 'bypassPermissions' },
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo allow' }] }] },
    enabledPlugins: { 'plugin@market': true }, mcpServers: { slack: { command: 'slack-mcp' } },
    enableAllProjectMcpServers: true, env: { ANTHROPIC_BASE_URL: 'https://gateway.example', DANGEROUS: '1' },
  }));
  const h = harness(t);
  await h.create({ ...assistantTransportOptions(), configDir });
  const o = h.options;
  assert.deepEqual(o.tools, [], 'no built-in tool, ToolSearch included');
  for (const tool of ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'WebFetch', 'Task', 'Skill', 'ToolSearch']) assert.ok(o.disallowedTools.includes(tool), tool);
  assert.equal(o.extraArgs.restricted, null, 'the CLI\'s --restricted');
  assert.equal(o.allowedTools, undefined, 'nothing is pre-approved');
  assert.deepEqual(o.settingSources, [], 'no user, project or local settings');
  assert.deepEqual(Object.keys(o.settings).sort(), ['disableAllHooks', 'model'], 'only provider keys of the user settings');
  assert.equal(o.settings.disableAllHooks, false, 'Michi\'s own hooks stay mandatory');
  assert.equal(o.env.ANTHROPIC_BASE_URL, 'https://gateway.example', 'the provider route is kept');
  assert.equal(o.env.DANGEROUS, undefined);
  assert.deepEqual(Object.keys(o.mcpServers), ['__michi_internal__']);
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.permissionMode, 'default');
  assert.equal(o.allowDangerouslySkipPermissions, false, 'no later switch to bypassPermissions either');
  assert.equal(o.extraArgs.bare, undefined, 'bare would turn off the PreToolUse hook');
});

test("the real SDK turns the assistant's options into the CLI flags that lock it down", async t => {
  const h = harness(t);
  t.mock.method(require('michi-runtime/internal/adapters/claude/claudeBinary'), 'findClaudeBinary', () => process.execPath);
  let argv: string[] = [];
  t.mock.method(require('../src/agents/processTree'), 'spawnAgentProcess', (_command: string, args: string[]) => { argv = args; return h.child; });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-sdk-argv-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  // The real SDK, its argv captured where it would start Claude Code: no process, no request.
  const transport = await createClaudeSdkTransport({
    cwd: configDir, configDir, onMessage: () => {}, onStderr: () => {}, onError: () => {},
    authorize: async () => ({ behavior: 'deny', message: 'test' }), preToolUse: async () => undefined,
    log: michiTestHost().observability.log, spawnEnv: process.env, ...assistantTransportOptions(),
  } as ClaudeSdkTransportOptions);
  transport.close();
  if (process.env.MICHI_PRINT_ASSISTANT_ARGV === '1') console.log(JSON.stringify(argv));
  const flag = (name: string) => argv.find((arg) => arg === name || arg.startsWith(`${name}=`));
  assert.equal(flag('--tools'), '--tools=', 'the CLI spelling of "no built-in tools"');
  assert.match(flag('--disallowedTools') ?? '', /^--disallowedTools=.*\bBash\b.*\bRead\b.*\bWrite\b/);
  assert.ok(argv.includes('--restricted'));
  assert.equal(flag('--setting-sources'), '--setting-sources=');
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(flag('--permission-mode'), '--permission-mode=default');
  assert.equal(flag('--allow-dangerously-skip-permissions'), undefined);
  assert.equal(flag('--dangerously-skip-permissions'), undefined);
  assert.equal(flag('--allowedTools'), undefined);
  assert.equal(flag('--bare'), undefined);
  const mcp = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['__michi_internal__']);
});
