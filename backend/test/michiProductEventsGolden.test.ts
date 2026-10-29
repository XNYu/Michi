import './helpers/claudeSdkFixture';
/**
 * Golden snapshot of Michi's product events (branches, artifacts, images,
 * branch overview and follow-ups), from the adapter that produces them to
 * the bytes a client reads and the payloads an Agent Run persists.
 *
 * Each adapter runs unchanged except at its process boundary. Claude's,
 * Codex's and Kiro's slots are served by Michi's MCP routes as server.ts
 * serves them, and their Michi tools are called over MCP as the agent CLI
 * calls them; their turn-metadata callbacks are driven the way the MCP host
 * drives them. The record per scenario holds:
 *   - wire: the SSE frames `encodeChatStreamEvent(toChatStreamEvent(event))`
 *     writes for each product event, in order;
 *   - run: every Agent Run event RuntimeRunExecutor emits for the same events
 *     (payloads serialized, so key order is pinned), and the Result Bundle's
 *     artifacts.
 *
 * Any change to those bytes shows up as a fixture diff. Regenerate it only
 * for an intended wire or Run payload change:
 *   MICHI_UPDATE_PRODUCT_EVENTS_GOLDEN=1 npm exec -w backend -- node --require ts-node/register --test test/michiProductEventsGolden.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { EventEmitter, PassThrough } from 'node:stream';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { encodeChatStreamEvent, type EffectiveAgentDefinitionV1 } from 'michi-shared';
import { toChatStreamEvent } from '../src/routes/chatStreamEvents';
import type { NormalizedEvent } from '../src/services/chatEvents';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions, RuntimeSessionOwner } from '../src/agents/types';
import type { AgentToolBridge, SpawnedBranch } from '../src/agents/toolBridge';
import { closeDb } from '../src/services/db';
import { McpSlotRegistry, mountMcp, type McpSlot } from '../src/services/mcpServer';
import { JSON_BODY_LIMIT_BYTES } from '../src/services/requestBodyLimit';
import { CodexSession } from 'michi-runtime/internal/adapters/codex/CodexSession';
import type { CodexAppServerClient } from 'michi-runtime/internal/adapters/codex/CodexAppServerClient';
import { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { KiroSession } from 'michi-runtime/internal/adapters/kiro/KiroSession';
import { mapAgentEvent } from '../src/agents/pi/eventMapper';
import { buildPiTools } from '../src/agents/pi/piTools';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import { RuntimeRunAdapterRegistry } from '../src/agents/runs/runtimeRunAdapterRegistry';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import type { AgentRunExecutionEvent, AgentRunSpec } from '../src/agents/runs/ports';
import { BackgroundSubagentRegistry } from '../src/services/backgroundSubagentRegistry';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { michiTestHost } from './helpers/michiTestHost';
import { runOwner } from './helpers/owners';
import { michiCodexHostText } from '../src/agents/michiCodexOptions';

const FIXTURE = path.join(__dirname, 'fixtures', 'michiProductEventsGolden', 'michiProductEvents.golden.json');
const UPDATE = process.env.MICHI_UPDATE_PRODUCT_EVENTS_GOLDEN === '1';
const expected: Record<string, unknown> = UPDATE || !fs.existsSync(FIXTURE) ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const actual: Record<string, unknown> = {};

/** The wire names of Michi's product events. */
const PRODUCT_EVENTS = new Set([
  'spawn_branches', 'branch_overview', 'follow_ups', 'follow_ups_status', 'artifact_saved', 'artifact_updated', 'image',
]);
/** Events the wire mapping does not translate (chatHub handles them itself). */
const UNMAPPED_KINDS = new Set(['runtime_error', 'turn_end']);

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let cwd: string;
let dataDir: string;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

before(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-product-events-')));
  fs.writeFileSync(path.join(cwd, 'chart.png'), PNG);
  // The MCP routes look the slot's chat up in the database.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-product-events-data-'));
  setEnv('MICHI_DATA_DIR', dataDir);
  // Both adapters read the follow-ups experiment mode from the environment.
  setEnv('MICHI_FOLLOW_UPS_EXPERIMENT_MODE', 'hook-tool');
  setEnv('MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC', undefined);
  setEnv('MICHI_NODE_SUMMARY_EXPERIMENT_MODE', undefined);
});

after(() => {
  closeDb();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (UPDATE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  }
});

// ---- Recording -----------------------------------------------------------------

function normalize(text: string): string {
  return text.split(cwd).join('<cwd>');
}

/** The SSE frames of the product events, in the order the adapter emitted them. */
function wireFrames(events: readonly NormalizedEvent[]): string[] {
  const frames: string[] = [];
  for (const event of events) {
    if (UNMAPPED_KINDS.has(event.kind)) continue;
    const wire = toChatStreamEvent(event);
    if (!wire || !PRODUCT_EVENTS.has(wire.event)) continue;
    frames.push(normalize(encodeChatStreamEvent(wire)));
  }
  return frames;
}

function productEvents(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  return events.filter((event) => {
    if (UNMAPPED_KINDS.has(event.kind)) return false;
    const wire = toChatStreamEvent(event);
    return !!wire && PRODUCT_EVENTS.has(wire.event);
  });
}

function runDefinition(): EffectiveAgentDefinitionV1 {
  return {
    version: 1, name: 'Worker', description: 'golden', instructions: 'Do the work.',
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'provider', modelId: 'model', reasoning: 'medium' },
    fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 },
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
  };
}

function runSpec(): AgentRunSpec {
  return {
    runId: 'run-golden', attemptId: 'attempt-golden', workspaceId: 'workspace-golden', ownerUserId: 'owner-golden', task: 'Do the work',
    effectiveDefinition: runDefinition(),
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: { version: 1, format: 'result_bundle', instructions: 'Return evidence' },
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd, sourceWorkspaceId: 'workspace-golden', snapshotHash: 'd'.repeat(64), createdAt: 1 },
    recoveryEnvelope: null,
  };
}

/** Replays the events as one Agent Run turn and records what the Run persists. */
async function runRecord(events: readonly NormalizedEvent[]): Promise<unknown> {
  const owner: RuntimeSessionOwner = runOwner('run-golden', 'attempt-golden');
  const session: AgentSession = {
    id: 'attempt-golden', runtimeId: 'pi', owner, runtimeProfileHash: null, nativeSessionId: null,
    getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {
      for (const event of events) yield event;
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    },
    async cancel() {},
  } as unknown as AgentSession;
  const runtime = {
    id: 'pi', label: 'golden',
    capabilities: { modes: false, permissions: true, models: true, providerModels: true, reasoning: true, supportedReasoningLevels: ['medium'], apiKeys: true, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false },
    async warm() {},
    async newSession(options: NewAgentSessionOptions) { (session as { runtimeProfileHash: string | null }).runtimeProfileHash = options.profileHash ?? null; return session; },
    releaseSession() {},
    async shutdown() {},
  } as unknown as AgentRuntime;
  const emitted: AgentRunExecutionEvent[] = [];
  const executor = new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: new RuntimeRunAdapterRegistry([new PiRunAdapter()]) });
  const handle = await executor.start(runSpec(), async (event) => { emitted.push(event); });
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');
  return {
    events: emitted.map((event) => normalize(JSON.stringify({ type: event.type, payload: event.payload }))),
    artifacts: outcome.status === 'completed' ? normalize(JSON.stringify(outcome.resultBundle.artifacts)) : null,
  };
}

async function record(name: string, events: readonly NormalizedEvent[]): Promise<void> {
  const recording = { wire: wireFrames(events), run: await runRecord(productEvents(events)) };
  actual[name] = recording;
  if (!UPDATE) assert.deepEqual(recording, expected[name], `${name} matches the golden fixture`);
}

// ---- Michi stubs ---------------------------------------------------------------

function goldenBridge(label: string): AgentToolBridge {
  let spawns = 0;
  return {
    async spawnBranches(args): Promise<SpawnedBranch[]> {
      spawns += 1;
      // The second call creates nothing: the event still reports an empty list.
      if (spawns > 1) return [];
      return args.topics.map((topic, index) => ({
        title: topic.title, prompt: topic.prompt, chatId: `${label}-child-chat-${index + 1}`, nodeId: `${label}-child-node-${index + 1}`,
      }));
    },
    saveContext: (args) => ({ id: `${label}-ctx-1`, name: args.name, filePath: `.contexts/${args.name}.md`, size: args.body?.length ?? 0 }),
    // No durable id: the event carries no contextId.
    updateContext: (args) => ({ name: args.name, filePath: `.contexts/${args.name}.md`, size: args.body.length }),
  };
}

const TOPICS = [
  { title: 'Alpha', prompt: 'Explore alpha' },
  { title: 'Beta', prompt: 'Explore beta' },
];

// ---- Michi's MCP routes ------------------------------------------------------------

type CallTool = (name: string, args: Record<string, unknown>) => Promise<void>;

/**
 * A slot registry behind Michi's MCP routes, served as server.ts serves them
 * (express.json, mountMcp under /api, on loopback). `tools(slot)` connects an
 * MCP client to the slot's URL and calls its tools, as the agent CLI does.
 */
async function michiMcp(): Promise<{
  registry: McpSlotRegistry;
  created: McpSlot[];
  tools: (slot: McpSlot) => Promise<CallTool>;
  close: () => Promise<void>;
}> {
  let port = 0;
  const registry = new McpSlotRegistry({ mcpPort: () => port });
  const created: McpSlot[] = [];
  const create = registry.create.bind(registry);
  registry.create = (...args: Parameters<McpSlotRegistry['create']>) => {
    const slot = create(...args);
    created.push(slot);
    return slot;
  };
  const app = express();
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
  const router = express.Router();
  mountMcp(router, registry);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
  const clients: Client[] = [];
  return {
    registry,
    created,
    async tools(slot) {
      const client = new Client({ name: 'michi-product-events-golden', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(registry.endpoint(slot.slotId).url)));
      clients.push(client);
      return async (name, args) => {
        const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text?: string }>; isError?: boolean };
        assert.notEqual(result.isError, true, `${name}: ${result.content.map((part) => part.text ?? '').join('')}`);
      };
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Michi's tools with an effect on the session, called over MCP in the order
 * every scenario uses.
 */
async function callMichiTools(callTool: CallTool): Promise<void> {
  await callTool('spawn_branches', { topics: TOPICS });
  await callTool('spawn_branches', { topics: [{ title: 'Gamma', prompt: 'Explore gamma' }] });
  await callTool('save_artifact', { name: 'notes', body: 'saved body' });
  await callTool('update_artifact', { name: 'notes', body: 'updated body' });
  await callTool('show_image', { path: 'chart.png', caption: 'Quarterly chart' });
  await callTool('show_image', { path: 'chart.png' });
}

/**
 * The turn-metadata callbacks, called directly: the adapter reports these
 * itself, and four follow-ups (more than set_follow_ups accepts) pin the
 * adapter's own cleaning.
 */
function setTurnMetadata(slot: McpSlot): void {
  assert.ok(slot.onSetBranchOverview && slot.onSetFollowUps, 'the slot takes turn metadata');
  slot.onSetBranchOverview('  Explored alpha and beta.  ');
  slot.onSetFollowUps([' First? ', 'Second?', 'Third?', 'Fourth?']);
}

// ---- Claude ----------------------------------------------------------------------

class MockClaudeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(signal?: string): boolean {
    this.killed = true;
    process.nextTick(() => this.emit('exit', signal === 'SIGKILL' ? 137 : 0, null));
    return true;
  }
  send(envelope: object): void { this.stdout.push(`${JSON.stringify(envelope)}\n`); }
}

function stubClaude(): { children: MockClaudeChild[]; restore: () => void } {
  const children: MockClaudeChild[] = [];
  const binary = require('michi-runtime/internal/adapters/claude/claudeBinary');
  const db = require('../src/services/dbRepository');
  const saved = { spawnClaude: binary.spawnClaude, preflight: binary.preflightClaudeAuth, setNode: db.setNodeExternalSessionId, getNode: db.getNode };
  binary.preflightClaudeAuth = () => {};
  binary.spawnClaude = () => { const child = new MockClaudeChild(); children.push(child); return child; };
  db.setNodeExternalSessionId = () => {};
  db.getNode = () => undefined;
  return {
    children,
    restore: () => {
      binary.spawnClaude = saved.spawnClaude;
      binary.preflightClaudeAuth = saved.preflight;
      db.setNodeExternalSessionId = saved.setNode;
      db.getNode = saved.getNode;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function claudeScenario(resume: boolean): Promise<NormalizedEvent[]> {
  const stub = stubClaude();
  const mcp = await michiMcp();
  const { ClaudeSession } = require('michi-runtime/internal/adapters/claude/ClaudeSession') as typeof import('michi-runtime/internal/adapters/claude/ClaudeSession');
  const session = new ClaudeSession(resume ? 'claude-resume' : 'claude-fresh', {
    nodeId: resume ? 'claude-resume-node' : 'claude-fresh-node',
    cwd,
    workspaceId: null,
    mcpRegistry: mcp.registry,
    bridge: goldenBridge(resume ? 'claude-resume' : 'claude-fresh'),
    options: claudeTestOptions({ followUpsHookPoc: () => true }),
    backgroundSubagents: new BackgroundSubagentRegistry({ resolveWorkspace: () => 'ws-golden' }),
  } as any);
  try {
    if (resume) await session.spawnResume('claude-native-resume');
    else await session.spawnFresh();
    assert.equal(mcp.created.length, 1, 'the process got one slot');
    const [slot] = mcp.created;
    const callTool = await mcp.tools(slot);
    const child = stub.children[0];
    const events: NormalizedEvent[] = [];
    const turn = (async () => { for await (const event of session.send('hello')) events.push(event); })();
    await tick();
    // A resumed process must confirm the restored identity before any output.
    if (resume) child.send({ type: 'system', subtype: 'init', session_id: 'claude-native-resume' });
    await callMichiTools(callTool);
    setTurnMetadata(slot);
    child.send({ type: 'stream_event', event: { type: 'message_stop' } });
    child.send({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    await turn;
    return events;
  } finally {
    await session.dispose();
    await mcp.close();
    stub.restore();
  }
}

test('Claude: a fresh session reports branches, artifacts, images, overview and follow-ups', async () => {
  await record('claude-fresh', await claudeScenario(false));
});

test('Claude: a resumed session reports the same events from its own slot', async () => {
  await record('claude-resume', await claudeScenario(true));
});

// ---- Codex -----------------------------------------------------------------------

function codexClient(): CodexAppServerClient & { emit: (method: string, params: Record<string, unknown>) => void } {
  const handlers = new Set<(method: string, params: Record<string, unknown>) => void>();
  const client: any = {
    ensureStarted: async () => {},
    request: async (method: string, params: any) => method === 'turn/start' ? { turn: { id: `native-${params.threadId}` } } : {},
    onNotification: (_threadId: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    onServerRequest: () => {},
    onGlobalNotification: () => () => {},
    onExit: () => () => {},
    shutdown: async () => {},
    emit: (method: string, params: Record<string, unknown>) => { for (const handler of handlers) handler(method, params); },
  };
  return client;
}

test('Codex: a session reports branches, artifacts, images, overview and follow-ups', async () => {
  const client = codexClient();
  const mcp = await michiMcp();
  const session = new CodexSession({
    nodeId: 'codex-golden', threadId: 'codex-golden-thread', cwd, workspaceId: null,
    client, mcpRegistry: mcp.registry, bridge: goldenBridge('codex'), host: michiTestHost(), hostText: michiCodexHostText(),
    followUpsHookPocEnabled: true, followUpsExperimentMode: 'hook-tool',
  });
  session.createMcpSlot();
  session.wireNotifications();
  try {
    assert.equal(mcp.created.length, 1, 'the session got one slot');
    const [slot] = mcp.created;
    const callTool = await mcp.tools(slot);
    const events: NormalizedEvent[] = [];
    const turn = (async () => { for await (const event of session.send('hello')) events.push(event); })();
    await tick();
    await callMichiTools(callTool);
    setTurnMetadata(slot);
    client.emit('item/completed', { threadId: 'codex-golden-thread', item: { id: 'answer', type: 'agentMessage', text: 'Answer.' } });
    await tick();
    client.emit('turn/completed', { threadId: 'codex-golden-thread', turn: { status: 'completed' } });
    await turn;
    await record('codex', events);
  } finally {
    await session.dispose();
    await mcp.close();
  }
});

// ---- Kiro --------------------------------------------------------------------------

test('Kiro: Michi tools called over MCP inject updates that the session reports as events', async () => {
  const injected: Array<Record<string, unknown>> = [];
  const mcp = await michiMcp();
  const runtime = new KiroRuntime({ bridge: goldenBridge('kiro'), mcpSlots: mcp.registry, defaultCwd: cwd, host: michiTestHost() });
  const rt = runtime as any;
  // The ACP client of the chat's cwd: every update injected into its session is the session's.
  rt.pool.set(cwd, {
    injectUpdate: (sessionId: string, update: Record<string, unknown>) => {
      assert.equal(sessionId, 'kiro-golden-sid');
      injected.push(update);
    },
  });
  // As KiroRuntime opens a chat: the slot of its ACP session, with the runtime's own callbacks.
  let slotId: string | undefined;
  const slot = mcp.registry.create('kiro-golden-sid', cwd, null, rt.makeSlotCallbacks(() => slotId),
    { nodeId: 'kiro-golden-node', workspaceId: null });
  slotId = slot.slotId;
  try {
    const callTool = await mcp.tools(slot);
    await callMichiTools(callTool);
    setTurnMetadata(slot);
  } finally {
    rt.pool.clear();
    await runtime.shutdown();
    await mcp.registry.dispose(slot.slotId);
    await mcp.close();
  }

  const fakeRuntime = {
    host: michiTestHost(),
    ensureClient: async () => ({
      prompt: async function* () {
        for (const update of injected) yield update;
        yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
      },
    }),
    getCurrentMode: () => undefined,
    getCurrentModel: () => undefined,
  } as unknown as KiroRuntime;
  const session = new KiroSession('kiro-golden-node', 'kiro-golden-sid', fakeRuntime, cwd);
  const events: NormalizedEvent[] = [];
  for await (const event of session.send('hello')) events.push(event);
  await record('kiro', events);
});

// ---- Pi ------------------------------------------------------------------------------

test('Pi: tool results and show_image report the same events', async (t) => {
  configureRuntimeDeps({
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null } as any,
    agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined } as any,
    dataDir: cwd,
  });
  t.after(() => __resetRuntimeDeps());
  const ctx = { cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 }, runStartMs: 0 };
  const events: NormalizedEvent[] = [];
  const end = (toolName: string, details: unknown) => {
    events.push(...mapAgentEvent({ type: 'tool_execution_end', toolName, toolCallId: `${toolName}-1`, isError: false, result: { content: [], details } }, ctx));
  };
  end('spawn_branches', { created: [
    { title: 'Alpha', prompt: 'Explore alpha', chatId: 'pi-child-chat-1', nodeId: 'pi-child-node-1' },
    { title: 'Beta', prompt: 'Explore beta', chatId: 'pi-child-chat-2', nodeId: 'pi-child-node-2' },
  ] });
  end('spawn_branches', { created: [] });
  end('save_artifact', { id: 'pi-ctx-1', name: 'notes', filePath: '.contexts/notes.md', size: 10 });
  end('update_artifact', { name: 'notes', filePath: '.contexts/notes.md', size: 12 });
  end('update_artifact', { name: 'notes', filePath: '.contexts/notes.md' });

  const Type: any = new Proxy({}, { get: () => () => ({}) });
  const tools = buildPiTools({
    bridge: goldenBridge('pi'), cwd, parentChatId: 'pi-golden', workspaceId: null, enableFollowUps: true,
    imageQuota: { usedBytes: 0, limitBytes: 1024 * 1024 } as any, seenPaths: new Set<string>(), Type,
    emitImage: (event: NormalizedEvent) => events.push(event),
  } as any);
  const showImage = tools.find((tool: any) => tool.name === 'show_image');
  assert.ok(showImage, 'show_image is registered');
  await showImage.execute('show-1', { path: 'chart.png', caption: 'Quarterly chart' });
  await showImage.execute('show-2', { path: 'chart.png' });
  await record('pi', events);
});
