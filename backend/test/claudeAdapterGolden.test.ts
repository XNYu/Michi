/**
 * Golden snapshot of what the Claude adapter hands the Claude Agent SDK, per
 * scenario: every transport's spawn options (the appended system prompt,
 * inline --mcp-config and --settings, permission mode, tool lists, CLI flags),
 * every user message it sends (first-turn prefix, per-turn reminders), the
 * MCP slots it creates or rebinds, and a timeline that shows when the native
 * session id is recorded relative to the SDK's envelopes and the turn's events.
 *
 * The adapter runs unchanged except at its process boundary: the SDK
 * transport is a scripted fake, and the Michi rows it reads are stubbed on
 * their modules. Any change to what reaches Claude Code, or to when the
 * native session id is recorded, shows up as a fixture diff.
 *
 * Regenerate the fixture only for an intended change:
 *   MICHI_UPDATE_CLAUDE_ADAPTER_GOLDEN=1 npm exec -w backend -- node --require ts-node/register --test test/claudeAdapterGolden.test.ts
 */

import './isolatedConfigDir';
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeSdkTransport, ClaudeSdkTransportOptions } from 'michi-runtime/internal/adapters/claude/claudeSdkTransport';
import type { AgentSession, AgentTurnInput, ChatMessage, RuntimeSessionOwner } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import { ClaudeRuntime } from 'michi-runtime/internal/adapters/claude/ClaudeRuntime';
import { getClaudeJsonlPath } from 'michi-runtime/internal/adapters/claude/claudeProjectsPath';
import { fakeMcpRegistry, type FakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { chatOwner, recordOwnerAsHost, runOwner } from './helpers/owners';

const FIXTURE = path.join(__dirname, 'fixtures', 'claudeAdapterGolden', 'claudeAdapter.golden.json');
const UPDATE = process.env.MICHI_UPDATE_CLAUDE_ADAPTER_GOLDEN === '1';
const MICHI_TOOL = 'mcp____michi_internal____';

/** Environment that changes what the adapter sends, pinned so the snapshot does not depend on the machine. */
const PINNED_ENV: Record<string, string | undefined> = {
  MICHI_CLOUD: undefined,
  MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC: undefined,
  MICHI_FOLLOW_UPS_EXPERIMENT_MODE: undefined,
  MICHI_NODE_SUMMARY_EXPERIMENT_MODE: undefined,
  MICHI_SCHEDULED_JOBS: undefined,
  MICHI_CLAUDE_BARE: undefined,
  MICHI_CLAUDE_STRICT_MCP: undefined,
  MICHI_CLAUDE_SUBAGENT_TEXT: undefined,
  MICHI_CLAUDE_HUMAN_ORIGIN: undefined,
  MICHI_CLAUDE_POOL_DISABLED: '1',
  MICHI_CLAUDE_POOL_SESSIONS_PER_CWD: undefined,
  MICHI_CLAUDE_WAIT_FOR_WARM: undefined,
  MICHI_CLAUDE_MAX_CONCURRENT: undefined,
  CLAUDE_CONFIG_DIR: undefined,
};

const savedEnv = new Map<string, string | undefined>();
function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let root: string;
let cwd: string;
let claudeConfigDir: string;
const transportModule = require('michi-runtime/internal/adapters/claude/claudeSdkTransport') as typeof import('michi-runtime/internal/adapters/claude/claudeSdkTransport');
const originalTransport = transportModule.createClaudeSdkTransport;
const expected: Record<string, unknown> = UPDATE || !fs.existsSync(FIXTURE) ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const actual: Record<string, unknown> = {};

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adapter-golden-')));
  cwd = path.join(root, 'work');
  claudeConfigDir = path.join(root, 'claude-config');
  fs.mkdirSync(cwd);
  setEnv(PINNED_ENV);
  transportModule.createClaudeSdkTransport = (args) => recorder.transport(args);
});

after(() => {
  transportModule.createClaudeSdkTransport = originalTransport;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
  if (UPDATE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  }
});

// ---- Recording ----------------------------------------------------------------

interface Recording {
  spawns: Array<Record<string, unknown>>;
  sent: Array<Record<string, unknown>>;
  slots: Array<Record<string, unknown>>;
  agentRunBindings: unknown[];
  forkAnchors: unknown[];
  submitted: unknown[];
  timeline: string[];
}

function newRecording(): Recording {
  return { spawns: [], sent: [], slots: [], agentRunBindings: [], forkAnchors: [], submitted: [], timeline: [] };
}

class FakeChild extends EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    if (this.exitCode === null) {
      this.exitCode = 0;
      queueMicrotask(() => this.emit('exit', 0, null));
    }
    return true;
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Transport options the adapter's own plumbing adds, which never reach the
 * SDK: the host's log. Left out so the snapshot holds what Claude Code gets.
 */
const ADAPTER_PLUMBING = new Set(['log', 'spawnEnv', 'binaryPath']);

/** Plain data of the spawn options; callbacks become their names. */
function spawnRecord(args: ClaudeSdkTransportOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(args).filter((key) => !ADAPTER_PLUMBING.has(key));
  for (const key of keys.sort()) {
    const value = (args as unknown as Record<string, unknown>)[key];
    if (typeof value === 'function') continue;
    if (key === 'mcpConfigInline' || key === 'settingsInline') {
      out[key] = typeof value === 'string' ? JSON.parse(value) : value;
      continue;
    }
    out[key] = value === undefined ? '<undefined>' : value;
  }
  out.callbacks = keys.filter((key) => typeof (args as unknown as Record<string, unknown>)[key] === 'function').sort();
  return out;
}

const recorder = {
  current: newRecording(),
  /** Extra fields of the fake system/init envelope. */
  initExtra: {} as Record<string, unknown>,
  warmInitsDone: 0,
  transport(args: ClaudeSdkTransportOptions): Promise<ClaudeSdkTransport> {
    const rec = this.current;
    const index = rec.spawns.length + 1;
    rec.spawns.push(spawnRecord(args));
    rec.timeline.push(`#${index} spawn`);
    const child = new FakeChild();
    const nativeId = args.sessionId ?? args.resumeSessionId ?? 'native-unset';
    let closed = false;
    let turn = 0;
    const deliver = async (label: string, envelope: Record<string, unknown>) => {
      await tick();
      if (closed) return;
      rec.timeline.push(`#${index} envelope ${label}`);
      args.onMessage(envelope);
    };
    const init = () => ({ type: 'system', subtype: 'init', session_id: nativeId, ...this.initExtra });
    const result = () => ({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    const query = {
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      stopTask: async () => {},
    };
    return Promise.resolve({
      child: child as unknown as ClaudeSdkTransport['child'],
      query: query as unknown as ClaudeSdkTransport['query'],
      initialized: Promise.resolve({}) as unknown as ClaudeSdkTransport['initialized'],
      send: (message) => {
        rec.sent.push({ spawn: index, ...(message as unknown as Record<string, unknown>) });
        const warm = (message as { shouldQuery?: boolean }).shouldQuery === false;
        rec.timeline.push(`#${index} send ${warm ? 'warm' : 'user'}`);
        void (async () => {
          await deliver('system/init', init());
          if (warm) {
            await deliver('result/success', result());
            this.warmInitsDone += 1;
            return;
          }
          turn += 1;
          await deliver('assistant', { type: 'assistant', uuid: `native-message-${index}-${turn}`, message: { role: 'assistant' } });
          await deliver('stream_event/text_delta', {
            type: 'stream_event',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `reply ${index}.${turn}` } },
          });
          await deliver('result/success', result());
        })();
      },
      close: () => { closed = true; },
    });
  },
};

/** Slot fields as the adapter set them; callbacks become their names. */
function slotRecord(registry: FakeMcpRegistry, slotId: string, label: string): Record<string, unknown> {
  const slot = registry.slots.get(slotId);
  assert.ok(slot, `slot ${slotId} exists`);
  const fields: Record<string, unknown> = { label, slotId };
  for (const key of Object.keys(slot).sort()) {
    const value = (slot as unknown as Record<string, unknown>)[key];
    if (key === 'slotId') continue;
    if (typeof value === 'function') continue;
    if (value instanceof Set) fields[key] = [...value].sort();
    else if (key === 'agentRuns') fields[key] = value ? '<invoker>' : '<undefined>';
    else fields[key] = value === undefined ? '<undefined>' : value;
  }
  fields.callbacks = Object.keys(slot).filter((key) => typeof (slot as unknown as Record<string, unknown>)[key] === 'function').sort();
  return fields;
}

function recordSlots(registry: FakeMcpRegistry, label: string): void {
  for (const slotId of registry.slots.keys()) recorder.current.slots.push(slotRecord(registry, slotId, label));
}

async function drainTurn(session: AgentSession, text: string, input?: AgentTurnInput): Promise<void> {
  const timeline = recorder.current.timeline;
  timeline.push(`turn ${JSON.stringify(text)}`);
  for await (const event of session.send(text, input)) {
    timeline.push(`event ${eventLabel(event)}`);
  }
}

function eventLabel(event: NormalizedEvent): string {
  switch (event.kind) {
    case 'chunk': return `chunk ${JSON.stringify(event.text)}`;
    case 'turn_end': return `turn_end ${event.stopReason}`;
    case 'runtime_error': return `runtime_error ${JSON.stringify(event.error)}`;
    case 'retry_start': return `retry_start ${JSON.stringify(event.detail)}`;
    // Michi's product events are host events, labelled by type as they were by kind.
    case 'host_event': return event.type === 'follow_ups_status'
      ? `follow_ups_status ${(event.payload as { status?: string }).status}`
      : event.type;
    default: return event.kind;
  }
}

/** Stable placeholders for paths and generated ids, in order of first appearance. */
function normalize(value: unknown): unknown {
  let text = JSON.stringify(value, recordOwnerAsHost);
  text = text.split(cwd).join('<cwd>').split(claudeConfigDir).join('<claude-config>').split(root).join('<root>');
  const ids = new Map<string, string>();
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
    if (!ids.has(id)) ids.set(id, `<uuid-${ids.size + 1}>`);
    return ids.get(id)!;
  });
  return JSON.parse(text);
}

// ---- Michi stubs ---------------------------------------------------------------

interface Stubs {
  workspaceInstructions?: Record<string, string>;
  nodes?: Record<string, Record<string, unknown>>;
  workspaces?: Record<string, Record<string, unknown>>;
  persistError?: string;
}

function stubMichi(t: TestContext, stubs: Stubs): void {
  const db = require('../src/services/dbRepository');
  t.mock.method(db, 'setNodeExternalSessionId', (nodeId: string, nativeId: string) => {
    recorder.current.timeline.push(`recordNativeSessionId ${nodeId} ${nativeId}`);
    if (stubs.persistError) throw new Error(stubs.persistError);
  });
  t.mock.method(db, 'getWorkspaceInstructions', (workspaceId: string) => stubs.workspaceInstructions?.[workspaceId] ?? null);
  t.mock.method(db, 'getNode', (nodeId: string) => stubs.nodes?.[nodeId]);
  t.mock.method(db, 'getWorkspace', (workspaceId: string) => stubs.workspaces?.[workspaceId]);
  t.mock.method(require('michi-runtime/internal/adapters/claude/claudeProjectsPath'), 'claudeTranscriptFindable', async () => true);
  t.mock.method(require('../src/services/claudeForkAnchors'), 'saveClaudeForkAnchor', (input: unknown) => {
    recorder.current.forkAnchors.push(input);
    recorder.current.timeline.push('saveClaudeForkAnchor');
  });
  const logger = require('../src/services/logger').log;
  for (const level of ['debug', 'info', 'warn', 'error'] as const) t.mock.method(logger, level, () => {});
}

function bridge() {
  return {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
    agentRunToolsForSession: (binding: unknown) => {
      recorder.current.agentRunBindings.push(binding);
      return { spawn: async () => ({}), check: async () => ({}), wait: async () => ({}), cancel: async () => ({}) } as never;
    },
  };
}

interface Harness {
  runtime: ClaudeRuntime;
  registry: FakeMcpRegistry;
}

function makeRuntime(): Harness {
  const registry = fakeMcpRegistry();
  const runtime = new ClaudeRuntime({ ...claudeTestOptions(), bridge: bridge() as never, mcpSlots: registry });
  return { runtime, registry };
}

async function scenario(t: TestContext, name: string, options: {
  env?: Record<string, string | undefined>;
  stubs?: Stubs;
  initExtra?: Record<string, unknown>;
}, run: (h: Harness) => Promise<void>): Promise<void> {
  setEnv({ ...PINNED_ENV, ...options.env });
  recorder.current = newRecording();
  recorder.initExtra = options.initExtra ?? {};
  recorder.warmInitsDone = 0;
  stubMichi(t, options.stubs ?? {});
  const h = makeRuntime();
  try {
    await run(h);
  } finally {
    await h.runtime.shutdown();
    sessionRegistry.clearAllSessions();
    setEnv(PINNED_ENV);
  }
  const recording = normalize(recorder.current);
  actual[name] = recording;
  if (!UPDATE) assert.deepEqual(recording, expected[name], `${name} matches the golden fixture`);
}

function parentSession(id: string, history: ChatMessage[]): AgentSession {
  return {
    id,
    runtimeId: 'claude',
    owner: chatOwner(id),
    getHistory: () => history,
    getPendingAssistant: () => undefined,
  } as unknown as AgentSession;
}

// ---- Scenarios -----------------------------------------------------------------

test('chat: new session with workspace instructions, merged contexts and a parent chain, two turns', async (t) => {
  await scenario(t, 'chat-new', { stubs: { workspaceInstructions: { 'ws-1': 'Answer in one paragraph.' } } }, async ({ runtime, registry }) => {
    sessionRegistry.registerSession(parentSession('parent-1', [
      { role: 'user', content: 'Parent question?' },
      { role: 'assistant', content: 'Parent answer.' },
    ]), null);
    const session = await runtime.newSession({
      sessionId: 'chat-1', cwd, parentChatId: 'parent-1', workspaceId: 'ws-1', ownerUserId: 'user-1',
      contextManifest: [{ name: 'spec', filePath: path.join(cwd, 'spec.md') }],
      mergeContexts: ['Merged thread text.'],
    });
    recordSlots(registry, 'after newSession');
    await drainTurn(session, 'First question', { assistantMessageId: 'assistant-1', userMessageId: 'user-msg-1', humanOrigin: true });
    await drainTurn(session, 'Second question', { assistantMessageId: 'assistant-2', userMessageId: 'user-msg-2' });
  });
});

test('chat: branch context replaces the live ancestor chain', async (t) => {
  await scenario(t, 'chat-branch-context', {}, async ({ runtime }) => {
    sessionRegistry.registerSession(parentSession('parent-2', [{ role: 'user', content: 'Live parent text that must not appear.' }]), null);
    const session = await runtime.newSession({
      sessionId: 'chat-2', cwd, parentChatId: 'parent-2', workspaceId: 'ws-2',
      branchContext: {
        parentNodeId: 'parent-2', kind: 'exact', boundaryMessageId: 'm-2',
        messages: [{ role: 'user', content: 'Branch point question' }, { role: 'assistant', content: 'Branch point answer' }],
        note: 'The parent was still answering.',
      },
    });
    await drainTurn(session, 'Branch question');
  });
});

test('chat: follow-ups off', async (t) => {
  await scenario(t, 'chat-follow-ups-off', {}, async ({ runtime }) => {
    const session = await runtime.newSession({ sessionId: 'chat-3', cwd, workspaceId: 'ws-3', enableFollowUps: false });
    await drainTurn(session, 'Quiet question');
    await drainTurn(session, 'Second quiet question');
  });
});

test('chat: native resume from the node binding with bootstrap instructions', async (t) => {
  await scenario(t, 'chat-resume', {
    stubs: { nodes: { 'chat-4': { id: 'chat-4', workspace_id: 'ws-4', kind: 'chat', status: 'idle', runtime_id: 'claude', external_session_id: 'native-resume-4' } } },
  }, async ({ runtime, registry }) => {
    const session = await runtime.loadSession!({
      sessionId: 'chat-4', nodeId: 'chat-4', cwd, workspaceId: 'ws-4', ownerUserId: null,
      bootstrapInstructions: 'Restored chat bootstrap.',
      replayHistory: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }],
    });
    recordSlots(registry, 'after loadSession');
    await drainTurn(session, 'Question after restore');
  });
});

test('chat: native fork of the parent\'s latest history', async (t) => {
  const source = '11111111-2222-4333-8444-555555555555';
  await scenario(t, 'chat-native-fork', {
    env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
    stubs: {
      nodes: {
        'parent-5': { id: 'parent-5', workspace_id: 'ws-5', tree_id: 'tree-5', kind: 'chat', status: 'idle', runtime_id: 'claude', external_session_id: source },
        'chat-5': { id: 'chat-5', workspace_id: 'ws-5', tree_id: 'tree-5', parent_node_id: 'parent-5', kind: 'chat', status: 'idle', runtime_id: 'claude' },
      },
      workspaces: { 'ws-5': { id: 'ws-5', cwd, owner_user_id: null } },
    },
  }, async ({ runtime }) => {
    const transcript = getClaudeJsonlPath(claudeTestOptions(), cwd, source, null);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    const session = await runtime.forkSession!({
      sessionId: 'chat-5', parentChatId: 'parent-5', cwd, workspaceId: 'ws-5', sourceNativeSessionId: source,
      owner: chatOwner('chat-5'),
      branchContext: { parentNodeId: 'parent-5', kind: 'exact', messages: [{ role: 'user', content: 'Not sent: native history replaces it' }] },
    });
    await drainTurn(session, 'Forked question');
  });
});

test('restricted profile: the Michi assistant', async (t) => {
  const allowed = ['list_threads', 'read_node', 'send_to_thread'];
  await scenario(t, 'assistant', {
    initExtra: { tools: allowed.map((name) => `${MICHI_TOOL}${name}`), mcp_servers: [{ name: '__michi_internal__', status: 'connected' }], permissionMode: 'default' },
  }, async ({ runtime, registry }) => {
    const session = await runtime.newSession({
      sessionId: 'assistant-1', cwd, workspaceId: 'ws-assistant',
      toolProfile: { allowedToolNames: allowed, restricted: true },
      bootstrapInstructions: 'Assistant bootstrap.',
    });
    recordSlots(registry, 'after newSession');
    await drainTurn(session, 'What are my threads doing?', { humanOrigin: true });
  });
});

test('agent run: bootstrap, Run tools and submit_agent_result', async (t) => {
  const owner = runOwner('run-1', 'attempt-1');
  await scenario(t, 'agent-run', {}, async ({ runtime, registry }) => {
    const session = await runtime.newSession({
      owner, sessionId: 'attempt-1', cwd, workspaceId: 'ws-run', ownerUserId: 'user-run', profileHash: 'profile-hash-1',
      bootstrapInstructions: 'Run bootstrap: fix the failing test.',
      toolProfile: {
        allowedToolNames: ['read', 'bash', 'edit', 'submit_agent_result', 'spawn_agent', 'check_agent'],
        runWorkerTools: {
          submitAgentResult: (submitter: RuntimeSessionOwner, payload: unknown) => {
            recorder.current.submitted.push({ submitter, payload });
            return { ok: true } as never;
          },
        },
      } as never,
      permissionBroker: { requestPermission: async () => 'allow_once' },
    });
    recordSlots(registry, 'after newSession');
    const [slot] = registry.slots.values();
    slot.onSubmitAgentResult?.({ summary: 'done' });
    await drainTurn(session, 'Start the run.', { humanOrigin: true });
  });
});

test('agent run: resume from the explicit token, never from a node row', async (t) => {
  const owner = runOwner('run-2', 'attempt-2');
  await scenario(t, 'agent-run-resume', {
    stubs: { nodes: { 'attempt-2': { id: 'attempt-2', workspace_id: 'ws-wrong', kind: 'chat', status: 'idle', external_session_id: 'native-from-node' } } },
  }, async ({ runtime, registry }) => {
    const session = await runtime.loadSession!({
      owner, sessionId: 'attempt-2', cwd, workspaceId: 'ws-run', ownerUserId: 'user-run',
      nativeResumeToken: 'native-run-token',
      bootstrapInstructions: 'Resumed run bootstrap.',
      toolProfile: { allowedToolNames: ['read', 'submit_agent_result'] },
    });
    recordSlots(registry, 'after loadSession');
    await drainTurn(session, 'Continue the run.');
  });
});

for (const mode of ['sentinel', 'hook-tool'] as const) {
  test(`follow-ups experiment: Stop-hook POC in ${mode} mode`, async (t) => {
    await scenario(t, `hook-poc-${mode}`, {
      env: { MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC: '1', MICHI_FOLLOW_UPS_EXPERIMENT_MODE: mode },
    }, async ({ runtime, registry }) => {
      const session = await runtime.newSession({ sessionId: `hook-${mode}`, cwd, workspaceId: 'ws-hook' });
      recordSlots(registry, 'after newSession');
      await drainTurn(session, 'Hook question one');
      await drainTurn(session, 'Hook question two');
    });
  });
}

test('follow-ups experiment: hook-tool mode without the Stop-hook POC', async (t) => {
  await scenario(t, 'follow-ups-hook-tool-without-poc', {
    env: { MICHI_FOLLOW_UPS_EXPERIMENT_MODE: 'hook-tool' },
  }, async ({ runtime }) => {
    const session = await runtime.newSession({ sessionId: 'hook-tool-plain', cwd, workspaceId: 'ws-hook' });
    await drainTurn(session, 'Plain hook-tool question');
  });
});

test('warm pool: a warm process handed to a chat rebinds its slot', async (t) => {
  await scenario(t, 'warm-handoff', {
    env: { MICHI_CLAUDE_POOL_DISABLED: undefined, MICHI_CLAUDE_POOL_SESSIONS_PER_CWD: '1' },
  }, async ({ runtime, registry }) => {
    await runtime.warm!(cwd);
    while (recorder.warmInitsDone < 1) await tick();
    recordSlots(registry, 'warm');
    const session = await runtime.newSession({ sessionId: 'chat-warm', cwd, workspaceId: 'ws-warm', ownerUserId: 'user-warm' });
    // take() refills the slot in the background; let that warm-up finish first.
    while (recorder.warmInitsDone < 2) await tick();
    recordSlots(registry, 'after handoff');
    await drainTurn(session, 'Warm question', { assistantMessageId: 'assistant-warm', userMessageId: 'user-msg-warm' });
  });
});

test('native session id: a failed record stops the session before it forwards any event', async (t) => {
  await scenario(t, 'record-failure', { stubs: { persistError: 'disk full' } }, async ({ runtime }) => {
    const session = await runtime.newSession({ sessionId: 'chat-fail', cwd, workspaceId: 'ws-fail' });
    await drainTurn(session, 'Question that cannot be bound');
  });
});

test('every scenario has a fixture entry', () => {
  if (UPDATE) return;
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
});
