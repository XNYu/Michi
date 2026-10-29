// Must stay first: agentConfig would otherwise read and write ~/.michi/config.json.
import './isolatedConfigDir';
import { after, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { RUNTIME_FACTORIES } from '../src/agents/runtimeFactories';
import { McpSlotRegistry } from '../src/services/mcpServer';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace, updateNodeResumeBinding } from '../src/services/dbRepository';
import { clearAllSessions, registerSession } from '../src/agents/sessionRegistry';
import { CREW_APP_VERSION } from 'michi-runtime/internal/adapters/crew/crewAppVersion';
import type { AgentRuntime, AgentSession } from '../src/agents/types';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { michiTestHost } from './helpers/michiTestHost';
import { runOwner } from './helpers/owners';

// Golden record of what the Kiro and Crew adapters send their agent process:
// the full text of every prompt (first-turn preamble, per-turn reminders,
// the MCP session note), the title prompt, every MCP server entry
// (URL, headers, name, `_meta`) and session option, and the native session
// identity each session reports. Recorded before the adapter moved onto the
// runtime host ports; any later byte difference is a behavior change.
// Regenerate (only for an intended change) with MICHI_WRITE_KIRO_ADAPTER_GOLDEN=1.

const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'kiroAdapterGolden');
const MCP_PORT = 43117;

function assertGolden(name: string, actual: unknown): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.MICHI_WRITE_KIRO_ADAPTER_GOLDEN === '1') {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, text);
  }
  assert.equal(text, fs.readFileSync(file, 'utf8'), `${name}.json`);
}

/** The env the adapters, the prompts and the title model read; pinned, then restored. */
const PINNED_ENV = [
  'MICHI_CLOUD', 'MICHI_CUSTOM_AGENTS', 'MICHI_KIRO_ENGINE', 'MICHI_NODE_SUMMARY_EXPERIMENT_MODE',
  'MICHI_TITLE_MODEL_KIRO', 'MICHI_TITLE_TIMEOUT_MS', 'MICHI_CREW_MEMORY_MODE', 'MICHI_CREW_ACP_BIN',
  'KIROCREW_HOME', 'MICHI_CREW_APP', 'MICHI_DATA_DIR', 'MICHI_KIRO_PRELOAD_TOOLS',
] as const;
const savedEnv = Object.fromEntries(PINNED_ENV.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];
after(() => {
  for (const key of PINNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  // realpath: macOS's /var -> /private/var must not show up in the records.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** A Crew install the factory's offline availability check accepts (no adapter process runs). */
function installFakeCrew(): void {
  const bin = path.join(tempDir('michi-kiro-golden-crew-bin-'), 'kirocrew-acp');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  const home = tempDir('michi-kiro-golden-crew-home-');
  const app = 'michi-crew-runtime';
  fs.mkdirSync(path.join(home, 'apps', app), { recursive: true });
  fs.writeFileSync(path.join(home, 'apps', app, '.app_secret'), '');
  fs.writeFileSync(path.join(home, 'apps', app, 'installed.json'), JSON.stringify({ name: app, enabled: true }));
  fs.writeFileSync(path.join(home, 'apps', app, 'app.json'), JSON.stringify({
    version: CREW_APP_VERSION, permissions: { sessionApproval: true }, mcpServers: { michi: {} },
  }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mcp_gateway: { stub_servers: [`${app}:michi`] } }));
  process.env.MICHI_CREW_ACP_BIN = bin;
  process.env.KIROCREW_HOME = home;
}

type WireEvent = Record<string, unknown>;

/** Replaces run-specific ids and paths with stable placeholders, in order of first appearance. */
class Normalizer {
  private readonly ids = new Map<string, string>();
  constructor(private readonly paths: Array<[string, string]>) {}

  text(value: string): string {
    let out = value;
    for (const [from, to] of this.paths) out = out.split(from).join(to);
    out = out.replace(/\/api\/mcp\/([A-Za-z0-9_-]+)/g, (_m, id: string) => `/api/mcp/${this.id('slot', id)}`);
    out = out.replace(/\/api\/mcp-session\/([A-Za-z0-9_-]+)/g, (_m, id: string) => `/api/mcp-session/${this.id('group', id)}`);
    return out;
  }

  private id(kind: string, raw: string): string {
    const key = `${kind}:${raw}`;
    let id = this.ids.get(key);
    if (!id) {
      id = `<${kind}-${[...this.ids.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1}>`;
      this.ids.set(key, id);
    }
    return id;
  }

  value(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.value(v)]));
    }
    return value;
  }
}

/** Every ACP call the adapter makes, recorded in order; no agent process is spawned. */
function recordAcp(t: TestContext, wire: WireEvent[]): void {
  let nextNative = 0;
  const proto = AcpClient.prototype as unknown as Record<string, unknown>;
  t.mock.method(AcpClient.prototype, 'start', () => {});
  t.mock.method(AcpClient.prototype, 'initialize', async function (this: AcpClient) {
    (this as unknown as { initialization: unknown }).initialization = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {}, list: {} } },
    };
  });
  t.mock.method(AcpClient.prototype, 'isAlive', () => true);
  t.mock.method(AcpClient.prototype, 'shutdown', async () => {});
  t.mock.method(AcpClient.prototype, 'cancel', async () => false);
  t.mock.method(AcpClient.prototype, 'destroySession', () => {});
  t.mock.method(AcpClient.prototype, 'hasSession', () => false);
  t.mock.method(AcpClient.prototype, 'newSession', async function (this: AcpClient, mcpServers: unknown[] = [], options?: unknown) {
    const sessionId = `native-${++nextNative}`;
    wire.push({ op: 'session/new', engine: this.engine, runtimeId: this.runtimeId, sessionId, mcpServers, options: options ?? null });
    return { sessionId, modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } };
  });
  t.mock.method(AcpClient.prototype, 'loadSession', async function (this: AcpClient, sessionId: string, _cwd: string,
    mcpServers: unknown[] = [], timeoutMs?: number, options?: unknown) {
    wire.push({ op: 'session/load', engine: this.engine, runtimeId: this.runtimeId, sessionId, mcpServers,
      timeoutMs: timeoutMs ?? null, options: options ?? null });
    return { modes: { currentModeId: 'default' }, ...(this.runtimeId === 'crew' ? { _meta: { crewMemoryMode: 'incognito' } } : {}) };
  });
  t.mock.method(AcpClient.prototype, 'forkSession', async function (this: AcpClient, sessionId: string, point?: unknown) {
    const child = `native-${++nextNative}`;
    wire.push({ op: 'session/fork', sessionId, point: point ?? null, child });
    return child;
  });
  t.mock.method(AcpClient.prototype, 'setModel', async (sessionId: string, modelId: string) => {
    wire.push({ op: 'setModel', sessionId, modelId });
  });
  t.mock.method(AcpClient.prototype, 'executeCommand', async (sessionId: string, command: string, args?: unknown) => {
    wire.push({ op: 'executeCommand', sessionId, command, args: args ?? null });
    return command === 'rewind'
      ? { success: true, data: { turns: [{ logIndex: 4, messageId: `turn-of-${sessionId}` }] } }
      : { success: true };
  });
  t.mock.method(AcpClient.prototype, 'getLastUserMessageId', (sessionId: string) => `user-message-of-${sessionId}`);
  t.mock.method(AcpClient.prototype, 'prompt', async function* (sessionId: string, text: string, extraBlocks: unknown[] = []) {
    wire.push({ op: 'session/prompt', sessionId, images: extraBlocks.length, text });
    yield { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Answer.' } };
    yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
  });
  assert.ok(typeof proto.prompt === 'function');
}

async function drain(session: AgentSession, text: string, input?: Parameters<AgentSession['send']>[1]): Promise<string[]> {
  const kinds: string[] = [];
  for await (const event of session.send(text, input)) kinds.push(event.kind);
  return kinds;
}

function identity(session: AgentSession): Record<string, unknown> {
  return {
    id: session.id,
    nativeSessionId: session.nativeSessionId ?? null,
    nativeEngine: session.nativeEngine ?? null,
    resumeToken: session.getNativeResumeToken?.() ?? null,
  };
}

function nodeColumns(nodeId: string): Record<string, unknown> {
  return getDb().prepare('SELECT acp_session_id, external_session_id, crew_memory_mode FROM nodes WHERE id = ?')
    .get(nodeId) as Record<string, unknown>;
}

function forkAnchors(): unknown[] {
  return getDb().prepare(`SELECT node_id, native_session_id, engine, assistant_message_id, user_message_id, log_index,
    native_message_id FROM kiro_fork_anchors ORDER BY node_id, assistant_message_id`).all();
}

async function errorOf(work: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try { await work(); return { error: null }; }
  catch (error) { return { name: (error as Error).name, message: (error as Error).message }; }
}

interface GoldenConfig {
  name: string;
  factory: 'kiro' | 'crew';
  engineEnv?: 'v2' | 'v3';
  cloud?: boolean;
}

const CONFIGS: GoldenConfig[] = [
  // Unset is v3; v2 stays a supported engine.
  { name: 'kiro-v2', factory: 'kiro', engineEnv: 'v2' },
  // Production v3: local chats share one MCP group per cwd, Agent Runs get isolated workers.
  { name: 'kiro-v3', factory: 'kiro', engineEnv: 'v3' },
  // Cloud v3: no shared group; every session runs on its own worker with a per-session slot.
  { name: 'kiro-v3-cloud', factory: 'kiro', engineEnv: 'v3', cloud: true },
  { name: 'crew', factory: 'crew' },
];

const bridge: AgentToolBridge = {
  spawnBranches: async () => [],
  saveContext: () => null,
  updateContext: () => null,
};

describe('Kiro adapter golden', () => {
  for (const config of CONFIGS) {
    test(config.name, async (t) => {
      for (const key of PINNED_ENV) delete process.env[key];
      const directory = tempDir('michi-kiro-golden-');
      const dataDir = tempDir('michi-kiro-golden-data-');
      process.env.MICHI_DATA_DIR = dataDir;
      if (config.engineEnv) process.env.MICHI_KIRO_ENGINE = config.engineEnv;
      if (config.cloud) process.env.MICHI_CLOUD = '1';
      if (config.factory === 'crew') installFakeCrew();
      closeDb();
      initDb();
      clearAllSessions();
      const owner = config.cloud ? 'alice' : null;
      saveWorkspace({
        id: 'ws', name: 'Golden', cwd: directory, created_at: 1, updated_at: 1, owner_user_id: owner,
        settings: JSON.stringify({ instructions: 'Workspace rule: answer in one paragraph.' }),
      });
      for (const id of ['node-a', 'node-b', 'node-c', 'node-d', 'node-e', 'node-f', 'node-parent']) {
        saveNode({ id, workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
      }

      const wire: WireEvent[] = [];
      recordAcp(t, wire);
      const factory = RUNTIME_FACTORIES.find((candidate) => candidate.id === config.factory);
      assert.ok(factory);
      const runtime: AgentRuntime = factory.create({
        bridge, mcpRegistry: new McpSlotRegistry({ mcpPort: MCP_PORT }), mcpPort: MCP_PORT,
        defaultCwd: directory, host: michiTestHost(),
      });
      const engine = runtime.nativeEngine ?? 'v2';
      const scenarios: Array<Record<string, unknown>> = [];
      const scenario = async (name: string, run: () => Promise<Record<string, unknown>>) => {
        const start = wire.length;
        const result = await run();
        scenarios.push({ name, ...result, wire: wire.slice(start) });
      };

      try {
        await scenario('chat: new, workspace instructions, contexts, three turns', async () => {
          const session = await runtime.newSession({
            sessionId: 'node-a', cwd: directory, workspaceId: 'ws', ownerUserId: owner,
            contextManifest: [{ name: 'notes.md', filePath: '/artifacts/notes.md', size: 120, kind: 'reference' }],
            extraContexts: [{ name: 'pinned.md', filePath: '/artifacts/pinned.md', size: 64, kind: 'embedded' }],
            mergeContexts: ['Merged context block.'],
          });
          updateNodeResumeBinding('node-a', { acp_session_id: session.nativeSessionId!, runtime_id: runtime.id, runtime_engine: engine });
          const turns = [
            await drain(session, 'First question?', { assistantMessageId: 'msg-a1', userMessageId: 'msg-u1' }),
            await drain(session, 'Second question?'),
            await drain(session, 'Third question?'),
          ];
          registerSession(session, owner);
          return { session: identity(session), turns, node: nodeColumns('node-a') };
        });

        await scenario('chat: new from a branch transcript, follow-ups off', async () => {
          const session = await runtime.newSession({
            sessionId: 'node-b', cwd: directory, workspaceId: 'ws', ownerUserId: owner, enableFollowUps: false,
            parentChatId: 'node-a',
            branchContext: {
              parentNodeId: 'node-a', kind: 'exact', boundaryMessageId: 'msg-a1',
              messages: [{ role: 'user', content: 'Parent question' }, { role: 'assistant', content: 'Parent answer' }],
              note: 'The parent was still answering.',
            },
          });
          const turns = [await drain(session, 'Branch question?'), await drain(session, 'Branch follow-up?')];
          return { session: identity(session), turns, node: nodeColumns('node-b') };
        });

        await scenario('chat: new under a live ancestor chain', async () => {
          registerSession({
            id: 'node-parent', runtimeId: runtime.id, getPendingAssistant: () => undefined,
            getHistory: () => [{ role: 'user', content: 'Ancestor question' }, { role: 'assistant', content: 'Ancestor answer' }],
            async *send() { /* never prompted */ }, async cancel() { return { acknowledged: false } as never; },
          } as unknown as AgentSession, owner);
          const session = await runtime.newSession({
            sessionId: 'node-e', cwd: directory, workspaceId: 'ws', ownerUserId: owner, parentChatId: 'node-parent',
          });
          const turns = [await drain(session, 'Child question?')];
          return { session: identity(session), turns, node: nodeColumns('node-e') };
        });

        await scenario('chat: resume a stored native session', async () => {
          updateNodeResumeBinding('node-c', { acp_session_id: 'native-stored-c', runtime_id: runtime.id, runtime_engine: engine });
          const session = await runtime.loadSession!({
            sessionId: 'native-stored-c', nodeId: 'node-c', cwd: directory, workspaceId: 'ws', ownerUserId: owner,
          });
          const turns = [await drain(session, 'Resumed question?')];
          return { session: identity(session), turns, node: nodeColumns('node-c') };
        });

        await scenario('chat: native fork at a recorded anchor', async () => {
          const parent = (nodeColumns('node-a').acp_session_id as string);
          const session = await runtime.forkSession!({
            sessionId: 'node-d', parentChatId: 'node-a', sourceNativeSessionId: parent, anchorMessageId: 'msg-a1',
            cwd: directory, workspaceId: 'ws', ownerUserId: owner, mergeContexts: ['Fork merge context.'],
          });
          const turns = [await drain(session, 'Forked question?')];
          return { session: identity(session), parentChatId: session.parentChatId ?? null, turns, node: nodeColumns('node-d') };
        });

        await scenario('chat: node summary experiment', async () => {
          process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE = 'full';
          try {
            const session = await runtime.newSession({ sessionId: 'node-f', cwd: directory, workspaceId: 'ws', ownerUserId: owner });
            const turns = [await drain(session, 'Summarized question?')];
            return { session: identity(session), turns, node: nodeColumns('node-f') };
          } finally {
            delete process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE;
          }
        });

        await scenario('agent run: new with bootstrap', async () => {
          const session = await runtime.newSession({
            sessionId: 'attempt-1', cwd: directory, workspaceId: 'ws', ownerUserId: owner,
            owner: runOwner('run-1', 'attempt-1'),
            toolProfile: { allowedToolNames: ['read', 'submit_agent_result'] },
            bootstrapInstructions: 'Run bootstrap: do the task, then submit the result.',
            permissionBroker: { requestPermission: async () => 'allow_once' },
          });
          const turns = [await drain(session, 'Run task text.')];
          return { session: identity(session), turns };
        });

        await scenario('agent run: resume from its token', async () => {
          const session = await runtime.loadSession!({
            sessionId: 'attempt-2', cwd: directory, workspaceId: 'ws', ownerUserId: owner,
            owner: runOwner('run-1', 'attempt-2'),
            toolProfile: { allowedToolNames: ['read'] },
            nativeResumeToken: { engine, sessionId: 'native-run-stored' },
          });
          const turns = [await drain(session, 'Resumed run text.')];
          return { session: identity(session), turns };
        });

        await scenario('restricted profile', async () => {
          const toolProfile = { allowedToolNames: ['read'], restricted: true } as never;
          return {
            newSession: await errorOf(() => runtime.newSession({ sessionId: 'node-x', cwd: directory, toolProfile })),
            loadSession: await errorOf(() => runtime.loadSession!({ sessionId: 'native-x', nodeId: 'node-x', cwd: directory, toolProfile })),
            forkSession: await errorOf(() => runtime.forkSession!({ sessionId: 'node-x', sourceNativeSessionId: 'native-x', cwd: directory, toolProfile })),
          };
        });

        await scenario('title', async () => ({
          title: await runtime.generateTitle?.({ userText: 'How do I rotate the signing key?', contextText: 'Earlier: key rotation runbook' }) ?? null,
        }));
      } finally {
        await runtime.shutdown();
        clearAllSessions();
      }

      const normalizer = new Normalizer([[directory, '<cwd>'], [dataDir, '<data>']]);
      assertGolden(config.name, normalizer.value({
        runtime: { id: runtime.id, engine },
        scenarios,
        forkAnchors: forkAnchors(),
      }));
      closeDb();
    });
  }
});
