import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpSlotProvider } from '../src/contract/mcp';
import type { AgentToolBridge } from '../src/contract/tools';
import type { NewAgentSessionOptions } from '../src/contract/types';
import { createDefaultHost } from '../src/core/defaultHost';
import { AcpAgentRuntime } from '../src/adapters/kiro/AcpAgentRuntime';
import { KIRO_FLAVOR } from '../src/adapters/kiro/acpAgentFlavor';
import type { AcpLaunch } from '../src/adapters/kiro/acpClient';
import { CREW_KIRO_FLAVOR } from '../src/adapters/crew/crewFlavor';
import {
  ANTIGRAVITY_HARNESS, ANTIGRAVITY_KIRO_FLAVOR, ANTIGRAVITY_STATIC_DESCRIPTOR, antigravityAvailability, createAntigravityRuntime,
  resolveAntigravityLaunch, type AntigravityAdapterOptions, type AntigravityRuntimeOptions,
} from '../src/adapters/antigravity/index';

const bridge: AgentToolBridge = {};
// Only stored at construction; the descriptor reads whether it is there.
const mcpSlots = {} as McpSlotProvider;
const tempDirs: string[] = [];
const NOT_FOUND = 'Antigravity CLI (agy) not found. Install it and sign in, or set MICHI_ANTIGRAVITY_BIN.';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-agy-preset-'));
  tempDirs.push(dir);
  return dir;
}

function executable(dir: string, name: string, body = 'exit 0'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function antigravity(options: Partial<AntigravityRuntimeOptions> = {}): AcpAgentRuntime {
  return createAntigravityRuntime({ host: createDefaultHost({ logLevel: 'silent' }), bridge, mcpSlots, ...options });
}

/** The options the preset passed AcpAgentRuntime. */
function kiroOptions(runtime: AcpAgentRuntime): Record<string, unknown> & { launch: AcpLaunch } {
  return (runtime as any).runtimeOptions;
}

const ANTIGRAVITY_CAPABILITIES = {
  modes: false,
  permissions: true,
  models: true,
  providerModels: false,
  reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high'],
  apiKeys: false,
  warmSessions: false,
  saveContext: true,
  spawnBranches: true,
  nativeResume: true,
  nativeResumeSettings: ['model', 'reasoning'],
};

describe('createAntigravityRuntime', () => {
  it("pins Antigravity's id, label, engine, flavor, descriptor and capabilities", () => {
    const runtime = antigravity();
    assert.ok(runtime instanceof AcpAgentRuntime);
    assert.equal(runtime.id, 'antigravity');
    assert.equal(runtime.label, 'Antigravity');
    assert.equal(runtime.engine, 'v2');
    assert.equal(runtime.flavor, ANTIGRAVITY_KIRO_FLAVOR);
    assert.deepEqual(runtime.descriptor, ANTIGRAVITY_STATIC_DESCRIPTOR);
    assert.deepEqual(runtime.capabilities, ANTIGRAVITY_CAPABILITIES);
  });

  it('keeps its pins over the same members from an untyped caller', () => {
    const runtime = antigravity({
      engine: 'v3', id: 'kiro', label: 'Kiro', flavor: KIRO_FLAVOR, sidecarTitles: true,
      launch: { bin: 'kiro-cli', args: () => [] }, descriptorOverride: {}, capabilitiesOverride: { warmSessions: true },
      checkAvailability: () => ({ available: true }),
    } as Partial<AntigravityRuntimeOptions>);
    assert.equal(runtime.id, 'antigravity');
    assert.equal(runtime.label, 'Antigravity');
    assert.equal(runtime.engine, 'v2');
    assert.equal(runtime.flavor, ANTIGRAVITY_KIRO_FLAVOR);
    assert.deepEqual(runtime.descriptor, ANTIGRAVITY_STATIC_DESCRIPTOR);
    assert.deepEqual(runtime.capabilities, ANTIGRAVITY_CAPABILITIES);
    assert.equal(kiroOptions(runtime).launch.standardAcp, true);
    assert.equal(runtime.checkAvailability().available, false);
  });

  it('passes the rest of its options to AcpAgentRuntime, and not its own', () => {
    const runtime = antigravity({ antigravity: {}, processCap: 7, defaultCwd: '/tmp/agy-default' });
    const options = kiroOptions(runtime);
    assert.equal(options.processCap, 7);
    assert.equal(options.bridge, bridge);
    assert.equal(options.mcpSlots, mcpSlots);
    assert.equal((runtime as any).defaultCwd, '/tmp/agy-default');
    assert.equal('antigravity' in options, false);
  });

  it('opens no sidecar title session where a Kiro runtime would', async () => {
    const host = createDefaultHost({
      logLevel: 'silent',
      titleModels: { kiro: { model: 'title-model', timeoutMs: 1_000 }, antigravity: { model: 'title-model', timeoutMs: 1_000 } },
      ports: { title: { enabled: () => true, prompt: () => '' } },
    });
    assert.notEqual((new AcpAgentRuntime({ host, bridge }) as any).titleGenerator, null);
    const runtime = createAntigravityRuntime({ host, bridge, mcpSlots });
    assert.equal((runtime as any).titleGenerator, null);
    assert.equal(await runtime.generateTitle({ userText: 'hello' }), null);
    assert.equal(runtime.descriptor.topology.titles, 'native-update');
  });

  it('checks availability at the locations given, read again at each check', async () => {
    const dir = tempDir();
    let locations: AntigravityAdapterOptions = { searchPath: dir };
    const runtime = antigravity({ antigravity: () => locations });
    assert.deepEqual(runtime.checkAvailability(), { available: false, detail: NOT_FOUND });
    await assert.rejects(runtime.ensureClient(tempDir()), { message: NOT_FOUND });

    executable(dir, 'agy');
    assert.deepEqual(runtime.checkAvailability(), { available: true });

    locations = { binPath: path.join(dir, 'missing-agy'), searchPath: dir };
    assert.deepEqual(runtime.checkAvailability(), {
      available: false, detail: `MICHI_ANTIGRAVITY_BIN=${path.join(dir, 'missing-agy')} is not an executable file`,
    });
  });

  it('finds agy in the first searchPath entry that has it, and prefers binPath', () => {
    const empty = tempDir();
    const first = tempDir();
    const second = tempDir();
    const notExecutable = path.join(empty, 'agy');
    fs.writeFileSync(notExecutable, '');
    const agy1 = executable(first, 'agy');
    executable(second, 'agy');
    const searchPath = ['', empty, first, second].join(path.delimiter);
    assert.equal(resolveAntigravityLaunch({ searchPath })?.bin, agy1);
    const explicit = executable(tempDir(), 'agy-explicit');
    assert.equal(resolveAntigravityLaunch({ binPath: ` ${explicit} `, searchPath })?.bin, explicit);
    assert.equal(resolveAntigravityLaunch({}), null);
    assert.deepEqual(antigravityAvailability({}), { available: false, detail: NOT_FOUND });
  });

  it('resolves its standard-ACP launch at each spawn, following binPath', () => {
    const dir = tempDir();
    const first = executable(dir, 'agy-1');
    const second = executable(dir, 'agy-2');
    let locations: AntigravityAdapterOptions = { binPath: first, extraArgs: ['--log-level', 'debug'] };
    const { launch } = kiroOptions(antigravity({ antigravity: () => locations }));
    assert.equal(launch.standardAcp, true);
    assert.equal(launch.standardFork, undefined);
    assert.equal(launch.cancelTimeoutMs, 10_000);
    assert.equal(launch.bin, first);
    // The model goes through the session's config option, not argv.
    assert.deepEqual(launch.args('gemini-3.8-flash'), ['acp', '--log-level', 'debug']);

    locations = { binPath: second };
    assert.equal(launch.bin, second);
    assert.deepEqual(launch.args(), ['acp']);
  });

  it('launches a child that exits at once with a readable line when agy does not resolve', () => {
    const runtime = antigravity();
    assert.equal(runtime.checkAvailability().detail, NOT_FOUND);
    const { launch } = kiroOptions(runtime);
    assert.equal(launch.bin, process.execPath);
    assert.deepEqual(launch.args('m1'), [
      '-e', "process.stderr.write('Antigravity CLI (agy) not found; set MICHI_ANTIGRAVITY_BIN\\n'); process.exit(1)",
    ]);
    const child = spawnSync(launch.bin, launch.args(), { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, 'Antigravity CLI (agy) not found; set MICHI_ANTIGRAVITY_BIN\n');
  });

  it("opens a session with Michi's stable prompt in _meta.antigravity, through `agy acp`", async (t) => {
    const dir = tempDir();
    const log = path.join(dir, 'received.json');
    const argvFile = path.join(dir, 'argv.json');
    const agent = path.join(dir, 'agy');
    fs.writeFileSync(agent, `#!${process.execPath}
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
const received = [];
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    received.push(msg);
    fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(received));
    if (msg.id === undefined || !msg.method) continue;
    const result = msg.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      : msg.method === 'session/new' ? { sessionId: 'agy-session-1' } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`);
    fs.chmodSync(agent, 0o755);
    const host = createDefaultHost({
      logLevel: 'silent',
      ports: { prompt: { stableSystemPrompt: (mode, followUps) => `STABLE ${mode} ${followUps}` } },
    });
    const runtime = createAntigravityRuntime({ host, bridge, antigravity: { binPath: agent } });
    t.after(() => runtime.shutdown());
    const cwd = tempDir();
    const session = await runtime.newSession({ cwd, sessionId: 'chat-1' });
    assert.equal(session.id, 'chat-1');
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), ['acp']);
    const received: any[] = JSON.parse(fs.readFileSync(log, 'utf8'));
    const sessionNew = received.find((msg) => msg.method === 'session/new');
    assert.deepEqual(sessionNew.params._meta, { antigravity: { systemPrompt: { append: 'STABLE sentinel true' } } });
    assert.deepEqual(received.filter((msg) => msg.method?.startsWith('_')).map((msg) => msg.method), []);
  });
});

describe('Antigravity flavor', () => {
  it("maps Michi's MCP tools to their own names and leaves other titles alone", () => {
    const title = ANTIGRAVITY_KIRO_FLAVOR.tools!.title!;
    assert.equal(title({ name: 'mcp_michi_ask_user', title: 'Run mcp_michi_ask_user' }), 'ask_user');
    assert.equal(title({ name: 'mcp_michi_michi_probe_echo' }), 'michi_probe_echo');
    assert.equal(title({ title: 'Run mcp_michi_set_follow_ups' }), 'set_follow_ups');
    assert.equal(title({ name: 'write_file', title: 'File hello.txt' }), undefined);
    assert.equal(title({ name: 'mcp_github_search', title: 'Run mcp_github_search' }), undefined);
    assert.equal(title({ name: 'mcp_michi_', title: 'Run mcp_michi_' }), undefined);
    assert.equal(title({}), undefined);
  });

  it("names a tool by agy's own tool name", () => {
    const name = ANTIGRAVITY_KIRO_FLAVOR.tools!.name!;
    assert.equal(name({ name: 'run_command', title: 'ls -la' }), 'run_command');
    assert.equal(name({ title: 'ls -la' }), undefined);
    assert.equal(name(undefined), undefined);
  });

  it("recognizes agy's signed-out error", () => {
    const signIn = ANTIGRAVITY_KIRO_FLAVOR.signIn!;
    assert.equal(signIn.matches({ code: -32000, message: 'Authentication required' }), true);
    assert.equal(signIn.matches('Error: authentication required'), true);
    assert.equal(signIn.matches({ code: -32603, message: 'Authentication required' }), false);
    assert.equal(signIn.matches({ code: -32000, message: 'Internal error' }), false);
    assert.equal(signIn.matches({ code: -32000 }), false);
    assert.match(signIn.message, /Run `agy` in a terminal and sign in/);
  });

  it('turns a session_info_update title into a title event', () => {
    assert.deepEqual(ANTIGRAVITY_KIRO_FLAVOR.sessionInfoEvents({ sessionUpdate: 'session_info_update', title: '  Fix the build  ' }),
      [{ kind: 'title', title: 'Fix the build' }]);
    assert.deepEqual(ANTIGRAVITY_KIRO_FLAVOR.sessionInfoEvents({ title: '   ' }), []);
  });

  it("sends a new chat only the host's variable first-turn prefix", () => {
    const host = createDefaultHost({
      logLevel: 'silent',
      ports: { prompt: { firstTurnPrefix: () => 'PREFIX', preamble: () => 'WHOLE PREAMBLE' } },
    });
    assert.equal(ANTIGRAVITY_KIRO_FLAVOR.prompt.firstMessage(host, { cwd: '/w', enableFollowUps: true }), 'PREFIX');
    assert.equal(ANTIGRAVITY_KIRO_FLAVOR.prompt.metadataChannel, 'tools');
    assert.equal(KIRO_FLAVOR.prompt.firstMessage(host, { cwd: '/w', enableFollowUps: true }), 'WHOLE PREAMBLE');
  });

  it("appends the stable system prompt, with native questions, for interactive chats only", () => {
    const calls: unknown[][] = [];
    const host = createDefaultHost({
      logLevel: 'silent',
      ports: { prompt: { stableSystemPrompt: (...args) => { calls.push(args); return 'STABLE'; } } },
    });
    const metadata = (opts: Partial<NewAgentSessionOptions>) => ANTIGRAVITY_KIRO_FLAVOR.sessionMetadata!(host, { cwd: '/w', ...opts });
    const profile = { allowedToolNames: ['read'] };
    assert.deepEqual(metadata({}), { antigravity: { systemPrompt: { append: 'STABLE' } } });
    assert.deepEqual(metadata({ owner: { mode: 'interactive', key: 'chat-1' }, enableFollowUps: false, toolProfile: profile }),
      { antigravity: { systemPrompt: { append: 'STABLE' } } });
    assert.deepEqual(calls, [
      ['sentinel', true, true, false, undefined],
      ['sentinel', false, true, false, profile],
    ]);
    calls.length = 0;
    assert.equal(metadata({ owner: { mode: 'headless', key: 'run-1' } }), undefined);
    assert.deepEqual(calls, []);
    // A restricted profile is passed on as restricted.
    metadata({ toolProfile: { allowedToolNames: [], restricted: true } });
    assert.equal(calls[0]?.[3], true);
  });

  it('sends no metadata when the host has no stable prompt', () => {
    const host = createDefaultHost({ logLevel: 'silent' });
    assert.equal(ANTIGRAVITY_KIRO_FLAVOR.sessionMetadata!(host, { cwd: '/w' }), undefined);
  });

  it("differs from kiro-cli's flavor only where agy does, and leaves Kiro's and Crew's alone", () => {
    assert.equal(ANTIGRAVITY_KIRO_FLAVOR.promptImages, 'resourceLink');
    assert.equal(ANTIGRAVITY_KIRO_FLAVOR.warmSessions, false);
    assert.equal(ANTIGRAVITY_KIRO_FLAVOR.sessionAnchors, false);
    assert.equal(ANTIGRAVITY_KIRO_FLAVOR.metersUsage, false);
    assert.deepEqual(ANTIGRAVITY_KIRO_FLAVOR.cancelAck, { kind: 'prompt-settlement' });
    assert.deepEqual(ANTIGRAVITY_KIRO_FLAVOR.nativeSessions, { replaceable: true });
    assert.deepEqual(ANTIGRAVITY_KIRO_FLAVOR.hostPorts, []);
    for (const flavor of [KIRO_FLAVOR, CREW_KIRO_FLAVOR]) {
      for (const key of ['promptImages', 'warmSessions', 'tools', 'signIn'] as const) assert.equal(flavor[key], undefined);
    }
  });
});

describe('Antigravity descriptor', () => {
  it("describes agy's harness: native resume, usage and approvals; no steer, compact, fork or subagents", () => {
    const harness = ANTIGRAVITY_HARNESS;
    for (const key of ['steer', 'compact', 'sessionFork', 'subagents'] as const) {
      assert.equal(harness[key].availability, 'invisible', key);
      assert.ok(harness[key].notes, `${key} says why`);
    }
    assert.deepEqual(harness.usage, { availability: 'native', confidence: 'native', notes: 'session/prompt usage: tokens; no cost or context %' });
    assert.deepEqual(harness.permissions, {
      availability: 'native', confidence: 'native',
      notes: 'session/request_permission for edits and commands; agy does not gate reads in the workspace or MCP tools',
    });
    assert.deepEqual(harness.nativeResume, { availability: 'native', confidence: 'native', notes: 'session/load after a session/list check' });
    assert.equal(harness.interruptAck.availability, 'native');
  });

  it('delivers Michi tools over HTTP MCP, titles natively, and runs no Agent Runs', () => {
    assert.deepEqual(ANTIGRAVITY_STATIC_DESCRIPTOR.topology.toolDelivery, ['mcp-http']);
    assert.equal(ANTIGRAVITY_STATIC_DESCRIPTOR.topology.titles, 'native-update');
    assert.equal(ANTIGRAVITY_STATIC_DESCRIPTOR.topology.cancel, 'native-ack');
    assert.equal(ANTIGRAVITY_STATIC_DESCRIPTOR.topology.hostTitleRequiresOptIn, undefined);
    assert.equal(ANTIGRAVITY_STATIC_DESCRIPTOR.run, null);
  });
});
