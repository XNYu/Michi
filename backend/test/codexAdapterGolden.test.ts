// Must stay first: agentConfig would otherwise read and write ~/.michi/config.json.
import './isolatedConfigDir';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeHost } from 'michi-runtime';
import { CodexRuntime, type CodexRuntimeTestSeams } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import type { CodexSession } from 'michi-runtime/internal/adapters/codex/CodexSession';
import type { CodexAppServerClient } from 'michi-runtime/internal/adapters/codex/CodexAppServerClient';
import type { AgentSession, ChatMessage, NewAgentSessionOptions } from '../src/agents/types';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import { closeDb } from '../src/services/db';
import { saveNode, saveWorkspace, updateNodeResumeBinding } from '../src/services/dbRepository';
import { fakeMcpRegistry, type FakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { michiTestHost } from './helpers/michiTestHost';
import { recordOwnerAsHost, runOwner } from './helpers/owners';
import { codexTestOptions } from './helpers/codexTestOptions';

// Golden snapshots of everything the Codex adapter sends to codex app-server
// (developer instructions, first-turn prefixes, per-turn text, title thread,
// thread config with its MCP server and Stop hook, sandbox and turn policies),
// the MCP slots it asks the host for, and when it records a native session id.
// They were recorded before the adapter moved onto the host ports and adapter
// options; any later byte difference is a change in what Codex receives.
// Regenerate (only for an intended change) with MICHI_WRITE_CODEX_GOLDEN=1.

const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'codexAdapterGolden');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CWD = '/tmp/michi-codex-golden';
const MCP_PORT = 3001;

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, (key, raw: unknown) => {
    const item = recordOwnerAsHost(key, raw);
    if (typeof item !== 'string') return item;
    return item.split(process.execPath).join('<node>').split(REPO_ROOT).join('<repo>');
  }));
}

function assertGolden(name: string, actual: unknown): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const text = `${JSON.stringify(normalize(actual), null, 2)}\n`;
  if (process.env.MICHI_WRITE_CODEX_GOLDEN === '1') {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, text);
  }
  assert.equal(text, fs.readFileSync(file, 'utf8'), `${name}.json`);
}

// ---- Environment the adapter and the Michi host read --------------------------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-codex-golden-'));
const pinnedEnv: Record<string, string | undefined> = {
  MICHI_DATA_DIR: dataDir,
  MICHI_CLOUD: undefined,
  MICHI_TITLE_MODEL_CODEX: undefined,
  MICHI_CODEX_TITLE_TIMEOUT_MS: undefined,
  MICHI_FOLLOW_UPS_EXPERIMENT_MODE: undefined,
  MICHI_CODEX_FOLLOW_UPS_HOOK_POC: undefined,
  MICHI_CODEX_MAX_CONCURRENT: undefined,
};
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  closeDb();
  for (const [key, value] of Object.entries(pinnedEnv)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saveWorkspace({
    id: 'ws-golden', name: 'Golden', cwd: CWD, created_at: 1, updated_at: 1,
    settings: JSON.stringify({ instructions: 'Answer in haiku when asked about weather.' }),
  });
  saveNode({ id: 'resume-node', workspace_id: 'ws-golden', title: 'Resumed', kind: 'chat',
    status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 } as Parameters<typeof saveNode>[0]);
  updateNodeResumeBinding('resume-node', { acp_session_id: 'thread-resumed', runtime_id: 'codex',
    model_id: 'gpt-golden', provider_id: null, reasoning: null, resume_fingerprint: null, current_mode_id: null });
});

after(() => {
  sessionRegistry.clearAllSessions();
  closeDb();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- A codex app-server that records every request ----------------------------

interface RecordedRequest { method: string; params: unknown }

const MODELS = [
  { id: 'gpt-golden', displayName: 'Golden', description: '', hidden: false, isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }], defaultReasoningEffort: 'medium' },
  { id: 'gpt-5.6-luna', displayName: 'Luna', description: '', hidden: false, isDefault: false,
    supportedReasoningEfforts: [], defaultReasoningEffort: 'low' },
];

function recordingClient() {
  const requests: RecordedRequest[] = [];
  const listeners = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  const turns = new Map<string, string>();
  let threads = 0;
  let turnCount = 0;
  const emit = (threadId: string, method: string, params: Record<string, unknown>) => {
    for (const listener of [...listeners.get(threadId) ?? []]) listener(method, params);
  };
  const client = {
    requests,
    turns,
    emit,
    ensureStarted: async () => {},
    isRunning: () => true,
    hasPendingRequests: () => false,
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params: JSON.parse(JSON.stringify(params ?? null)) });
      switch (method) {
        case 'model/list': return { data: MODELS };
        case 'thread/start':
          return { thread: { id: params.ephemeral ? `title-thread-${++threads}` : `thread-${++threads}` } };
        case 'thread/fork': return { thread: { id: `forked-thread-${++threads}` } };
        case 'thread/resume': return { thread: { id: params.threadId } };
        case 'config/read': return { config: { mcp_servers: { 'user-server': { command: 'user-mcp' } } } };
        case 'mcpServerStatus/list':
          return { data: [{ name: '__michi_internal__', runtimeStatus: 'ready' }, { name: 'user-server', runtimeStatus: 'disabled' }] };
        case 'turn/start': {
          const threadId = String(params.threadId);
          const turnId = `turn-${++turnCount}`;
          turns.set(threadId, turnId);
          if (threadId.startsWith('title-thread-')) {
            queueMicrotask(() => {
              emit(threadId, 'turn/started', { threadId, turn: { id: turnId } });
              emit(threadId, 'item/agentMessage/delta', { threadId, delta: '{"title":"Golden title"}' });
              emit(threadId, 'turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
            });
          }
          return { turn: { id: turnId } };
        }
        default: return {};
      }
    },
    onNotification: (threadId: string, listener: (method: string, params: Record<string, unknown>) => void) => {
      const set = listeners.get(threadId) ?? new Set();
      listeners.set(threadId, set);
      set.add(listener);
      return () => { set.delete(listener); };
    },
    onGlobalNotification: () => () => {},
    onServerRequest: () => {},
    onExit: () => () => {},
    shutdown: async () => {},
  };
  return client;
}

type RecordingClient = ReturnType<typeof recordingClient>;

// ---- The host and MCP slots, recorded -------------------------------------------

interface RecordedSlot {
  parentChatId: string;
  cwd: string;
  ownerUserId: string | null;
  opts: unknown;
  callbacks: string[];
  restricted?: boolean;
  exposedToolNames?: string[];
  agentRunToolNames?: string[];
  owner?: unknown;
}

function recordingRegistry(): { registry: FakeMcpRegistry; slots: RecordedSlot[] } {
  const slots: RecordedSlot[] = [];
  const registry = fakeMcpRegistry({}, { mcpPort: MCP_PORT });
  const create = registry.create.bind(registry);
  registry.create = (parentChatId, cwd, ownerUserId, cbs, opts) => {
    const record = cbs as unknown as Record<string, unknown>;
    slots.push({
      parentChatId, cwd, ownerUserId, opts: opts ?? null,
      callbacks: Object.keys(record).filter((key) => typeof record[key] === 'function').sort(),
      ...(cbs.restricted !== undefined ? { restricted: cbs.restricted } : {}),
      ...(cbs.exposedToolNames ? { exposedToolNames: [...cbs.exposedToolNames].sort() } : {}),
      ...(cbs.agentRunToolNames ? { agentRunToolNames: [...cbs.agentRunToolNames].sort() } : {}),
      ...(cbs.owner ? { owner: cbs.owner } : {}),
    });
    return create(parentChatId, cwd, ownerUserId, cbs, opts);
  };
  return { registry, slots };
}

function recordingHost(recorded: unknown[]): RuntimeHost {
  const host = michiTestHost();
  host.bindings = {
    ...host.bindings,
    recordNativeSessionId: (owner, nativeSessionId) => {
      recorded.push({ owner, nativeSessionId });
      host.bindings.recordNativeSessionId(owner, nativeSessionId);
    },
  };
  return host;
}

const bridge: AgentToolBridge = {
  spawnBranches: async () => [],
  saveContext: () => null,
  updateContext: () => null,
};

interface Harness {
  runtime: CodexRuntime;
  client: RecordingClient;
  slots: RecordedSlot[];
  recordedNativeSessionIds: unknown[];
}

function harness(seams: Pick<CodexRuntimeTestSeams, 'followUpsHookPocEnabled' | 'followUpsExperimentMode'> = {}): Harness {
  const client = recordingClient();
  const { registry, slots } = recordingRegistry();
  const recordedNativeSessionIds: unknown[] = [];
  const runtime = new CodexRuntime({ ...codexTestOptions({ host: recordingHost(recordedNativeSessionIds) }), bridge, mcpSlots: registry }, {
    client: client as unknown as CodexAppServerClient,
    followUpsHookPocEnabled: seams.followUpsHookPocEnabled ?? false,
    ...(seams.followUpsExperimentMode ? { followUpsExperimentMode: seams.followUpsExperimentMode } : {}),
  });
  return { runtime, client, slots, recordedNativeSessionIds };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** One user turn: send, let the native turn start, then complete it. */
async function turn(h: Harness, session: CodexSession, text: string): Promise<string[]> {
  const kinds: string[] = [];
  const before = h.client.requests.length;
  const drained = (async () => {
    for await (const event of session.send(text)) {
      if (event.kind !== 'heartbeat') kinds.push(event.kind === 'title' ? `title:${event.title}` : event.kind);
    }
  })();
  for (let i = 0; i < 20; i += 1) {
    await tick();
    if (h.client.requests.slice(before).some((r) => r.method === 'turn/start'
      && (r.params as { threadId?: string }).threadId === session.threadId)) break;
  }
  const turnId = h.client.turns.get(session.threadId);
  assert.ok(turnId, `turn/start for ${session.threadId}`);
  await tick();
  h.client.emit(session.threadId, 'turn/completed', { threadId: session.threadId, turn: { id: turnId, status: 'completed' } });
  await drained;
  return kinds;
}

interface ScenarioResult {
  nativeSessionId: string | null;
  turns: string[][];
}

async function snapshot(h: Harness, result: ScenarioResult) {
  await h.runtime.shutdown();
  return {
    nativeSessionId: result.nativeSessionId,
    recordedNativeSessionIds: h.recordedNativeSessionIds,
    turnEvents: result.turns,
    slots: h.slots,
    requests: h.client.requests,
  };
}

/** A registered ancestor session with a fixed transcript. */
function ancestor(id: string, parentChatId: string | undefined, history: ChatMessage[], pending?: string): AgentSession {
  return {
    id, runtimeId: 'pi', parentChatId, currentModeId: null, currentModelId: null,
    getHistory: () => history,
    getPendingAssistant: () => pending,
    async *send() { throw new Error('ancestor fixture is read-only'); },
    cancel: () => {},
  } as AgentSession;
}

async function chatScenario(h: Harness, opts: NewAgentSessionOptions, texts: string[]): Promise<ScenarioResult> {
  const session = await h.runtime.newSession(opts) as CodexSession;
  const nativeSessionId = session.nativeSessionId;
  const turns: string[][] = [];
  for (const text of texts) turns.push(await turn(h, session, text));
  return { nativeSessionId, turns };
}

// ---- Scenarios -----------------------------------------------------------------

describe('Codex adapter golden', () => {
  test('chat: new session with ancestors, workspace instructions and contexts', async () => {
    sessionRegistry.registerSession(ancestor('golden-root', undefined, [
      { role: 'user', content: 'Root question' },
      { role: 'assistant', content: 'Root answer' },
    ]), null);
    sessionRegistry.registerSession(ancestor('golden-parent', 'golden-root', [
      { role: 'user', content: 'Parent question' },
      { role: 'assistant', content: 'Parent answer' },
    ], 'Parent still typing'), null);
    const h = harness();
    try {
      const result = await chatScenario(h, {
        sessionId: 'chat-new', cwd: CWD, model: 'gpt-golden', reasoning: 'high', workspaceId: 'ws-golden',
        parentChatId: 'golden-parent', ownerUserId: 'user-golden',
        contextManifest: [{ name: 'design-doc', filePath: '.artifacts/design-doc.md' }],
        extraContexts: [{ name: 'pinned-link', filePath: '', url: 'https://example.com/spec' }],
        mergeContexts: ['Merged branch notes.'],
      }, ['First question', 'Second question', 'Third question']);
      assertGolden('chat-new', await snapshot(h, result));
    } finally {
      sessionRegistry.dropSession('golden-root');
      sessionRegistry.dropSession('golden-parent');
    }
  });

  test('chat: default model, follow-ups disabled', async () => {
    const h = harness();
    const result = await chatScenario(h, { sessionId: 'chat-default-model', cwd: CWD, enableFollowUps: false }, ['Only question']);
    assertGolden('chat-default-model', await snapshot(h, result));
  });

  test('chat: server-resolved branch context replaces the live ancestor chain', async () => {
    sessionRegistry.registerSession(ancestor('golden-live-parent', undefined, [
      { role: 'user', content: 'Live parent question' },
    ]), null);
    const h = harness();
    try {
      const result = await chatScenario(h, {
        sessionId: 'chat-branch', cwd: CWD, model: 'gpt-golden', parentChatId: 'golden-live-parent',
        branchContext: {
          parentNodeId: 'golden-live-parent', kind: 'exact', boundaryMessageId: 'm2',
          messages: [{ role: 'user', content: 'Branch point question' }, { role: 'assistant', content: 'Branch point answer' }],
          note: 'The parent was still answering.',
        },
      }, ['Branch question']);
      assertGolden('chat-branch-context', await snapshot(h, result));
    } finally {
      sessionRegistry.dropSession('golden-live-parent');
    }
  });

  test('chat: native fork', async () => {
    const h = harness();
    const session = await h.runtime.forkSession({
      sessionId: 'chat-fork', cwd: CWD, model: 'gpt-golden', parentChatId: 'fork-parent',
      sourceNativeSessionId: 'thread-fork-parent',
      branchContext: { parentNodeId: 'fork-parent', kind: 'exact', messages: [{ role: 'user', content: 'Forked from here' }] },
    }) as CodexSession;
    const result = { nativeSessionId: session.nativeSessionId, turns: [await turn(h, session, 'Fork question')] };
    assertGolden('chat-fork', await snapshot(h, result));
  });

  test('chat: resume from the node binding', async () => {
    const h = harness();
    const session = await h.runtime.loadSession({
      sessionId: 'resume-node', cwd: CWD, model: 'gpt-golden', workspaceId: 'ws-golden',
    }) as CodexSession;
    const result = { nativeSessionId: session.nativeSessionId, turns: [await turn(h, session, 'Resumed question')] };
    assertGolden('chat-resume', await snapshot(h, result));
  });

  test('chat: native recovery after a crash', async () => {
    const h = harness();
    const session = await h.runtime.newSession({ sessionId: 'chat-recovery', cwd: CWD, model: 'gpt-golden', reasoning: 'low' }) as CodexSession;
    const turns = [await turn(h, session, 'Before the crash')];
    session.markCrashed('golden crash');
    turns.push(await turn(h, session, 'After the crash'));
    assertGolden('chat-recovery', await snapshot(h, { nativeSessionId: session.nativeSessionId, turns }));
  });

  test('chat: Trust mode turn policy', async (t) => {
    configureRuntimeDeps({
      dataDir,
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
      agentConfig: { getAgentConfig: () => ({ runtime: 'codex', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }),
        resolveModel: () => '', resolveReasoning: () => undefined },
      chatPermissions: { getMode: () => 'trust', hasGrant: () => false, grant: () => {}, resetToken: () => '0' },
    });
    t.after(__resetRuntimeDeps);
    const h = harness();
    const result = await chatScenario(h, { sessionId: 'chat-trust', cwd: CWD, model: 'gpt-golden' }, ['Trusted question']);
    assertGolden('chat-trust', await snapshot(h, result));
  });

  test('assistant: restricted profile with its bootstrap', async () => {
    const h = harness();
    const result = await chatScenario(h, {
      sessionId: 'assistant', cwd: CWD, model: 'gpt-golden', workspaceId: 'ws-golden',
      bootstrapInstructions: 'You are the golden assistant.',
      toolProfile: { restricted: true, allowedToolNames: ['read_node', 'list_threads'] },
    }, ['Assistant question']);
    assertGolden('assistant', await snapshot(h, result));
  });

  test('agent run: bootstrap, Run slot and resume', async () => {
    const h = harness();
    const owner = runOwner('run-golden', 'attempt-golden');
    const toolProfile = { allowedToolNames: ['submit_agent_result', 'read_node'] };
    const session = await h.runtime.newSession({
      sessionId: 'attempt-golden', cwd: CWD, model: 'gpt-golden', owner, toolProfile, workspaceId: 'ws-golden',
      bootstrapInstructions: 'Run bootstrap: finish the task and submit a result.',
      permissionBroker: { requestPermission: async () => 'deny' },
    }) as CodexSession;
    const turns = [await turn(h, session, 'Run turn one'), await turn(h, session, 'Run turn two')];
    const nativeSessionId = session.nativeSessionId;
    await h.runtime.releaseSession('attempt-golden');
    const resumed = await h.runtime.loadSession({
      sessionId: 'attempt-golden', cwd: CWD, model: 'gpt-golden', owner, toolProfile, nativeResumeToken: nativeSessionId,
    }) as CodexSession;
    turns.push(await turn(h, resumed, 'Run turn after resume'));
    assertGolden('agent-run', await snapshot(h, { nativeSessionId, turns }));
  });

  for (const mode of ['sentinel', 'hook-tool'] as const) {
    test(`follow-ups Stop-hook experiment: ${mode}`, async () => {
      const h = harness({ followUpsHookPocEnabled: true, followUpsExperimentMode: mode });
      const result = await chatScenario(h, { sessionId: `hook-${mode}`, cwd: CWD, model: 'gpt-golden' }, ['Hook question', 'Hook follow-up']);
      assertGolden(`hook-${mode}`, await snapshot(h, result));
    });
  }

  test('follow-ups Stop-hook experiment: follow-ups disabled', async () => {
    const h = harness({ followUpsHookPocEnabled: true, followUpsExperimentMode: 'hook-tool' });
    const result = await chatScenario(h, { sessionId: 'hook-disabled', cwd: CWD, model: 'gpt-golden', enableFollowUps: false }, ['No follow-ups']);
    assertGolden('hook-follow-ups-disabled', await snapshot(h, result));
  });

  test('follow-ups Stop-hook experiment: agent run', async () => {
    const h = harness({ followUpsHookPocEnabled: true, followUpsExperimentMode: 'hook-tool' });
    const session = await h.runtime.newSession({
      sessionId: 'hook-attempt', cwd: CWD, model: 'gpt-golden',
      owner: runOwner('hook-run', 'hook-attempt'),
      toolProfile: { allowedToolNames: ['submit_agent_result'] },
      bootstrapInstructions: 'Hook run bootstrap.',
    }) as CodexSession;
    const result = { nativeSessionId: session.nativeSessionId, turns: [await turn(h, session, 'Hook run turn')] };
    assertGolden('hook-agent-run', await snapshot(h, result));
  });
});
