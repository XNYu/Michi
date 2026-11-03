// A minimal server-side host of michi-runtime. It has no HTTP API of its
// own: its one listener is the MCP host's listen() (127.0.0.1, a free port),
// which carries the host's tool to the agent. It runs one agent through a host
// tool call, an approval, a cancel and a native resume, all in this process.
//
//   node minimal-server-host.ts [--runtime kiro|crew|codex|claude] [--engine v2|v3]
//        [--approval allow|deny] [--cwd DIR] [--timeout-ms N]
//   node minimal-server-host.ts --check [--runtime kiro|crew|codex|claude|all]
//
// --runtime falls back to EXAMPLE_RUNTIME, then to kiro; --engine is Kiro's.
// The approval step is denied unless --approval allow, which answers each of
// its requests with allow_once: never a standing grant. --check builds the
// runtimes, listens, prints their ready lines and exits 0; it starts no agent.
//
// Run it with a Node that strips types (24, or 22.18 and later) in an ES
// module project ("type": "module" in its package.json; `npm init -y` writes
// "commonjs") that installed the package (`npm install <tarball>`, and
// @anthropic-ai/claude-agent-sdk too for Claude), or save it there as
// minimal-server-host.mts. The agent CLI must be installed and signed in.
// Every stdout line is one JSON object. Exit code: 0 when every step passed,
// 1 when one failed, 2 when the runtime is unavailable.
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createDefaultHost, createRuntimeManager, interactiveOwner,
  type AgentRuntime, type AgentSession, type AgentToolBridge, type CancelAck, type McpSlot, type McpSlotProvider,
  type NormalizedEvent, type RuntimeAvailability, type RuntimeHost,
} from 'michi-runtime';
import { createMcpHost, createMcpSlotProvider } from 'michi-runtime/mcp-host';
import { AcpAgentRuntime, resolveKiroEngine } from 'michi-runtime/adapters/kiro';
import { createCrewRuntime } from 'michi-runtime/adapters/crew';
import { CodexRuntime } from 'michi-runtime/adapters/codex';
import { ClaudeRuntime, ClaudeSdkMissingError, claudeAdapterOptions } from 'michi-runtime/adapters/claude';

const RUNTIMES = ['kiro', 'crew', 'codex', 'claude'] as const;
type RuntimeName = typeof RUNTIMES[number];
type PermissionRequest = Extract<NormalizedEvent, { kind: 'permission_request' }>;

const PROMPTS = {
  tool: 'This is a test of your tools. Call the tool named example_token exactly once, with no arguments. '
    + 'If it is not offered to you directly, find it with the tool that lists the host tools of this conversation '
    + 'and call it through the tool that calls them. It returns a made-up code word, not a secret. '
    + 'Reply with that word and nothing else. Do not run commands or edit files.',
  approval: 'Create a file named example-approval.txt in the current working directory whose whole content is '
    + 'the text example-approval. Use a file-writing tool or one shell command. If the request is denied, do not '
    + 'try another way; reply that it was denied.',
  count: 'Count from 1 to 400, one number per line, with no other text. Do not use any tools.',
  recall: 'Without calling any tool, reply with the code word the example_token tool returned earlier in this '
    + 'conversation, and nothing else.',
};

const print = (line: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(line)}\n`); };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// No bridge methods: the adapters then offer none of the product tools
// (spawn_branches, save_artifact, update_artifact) that need one.
const bridge: AgentToolBridge = {};

function buildRuntime(name: RuntimeName, host: RuntimeHost, mcpSlots: McpSlotProvider, cwd: string, engine?: string): AgentRuntime {
  // spawnEnv decides what the agent sees of this process's environment,
  // credentials included. Codex and Claude get all of it here, Kiro inherits
  // it when spawnEnv is absent, and Crew's adapter always inherits it. A host
  // holding secrets the agent must not see passes a filtered copy instead.
  switch (name) {
    case 'kiro': return new AcpAgentRuntime({ host, bridge, mcpSlots, defaultCwd: cwd, engine: resolveKiroEngine(engine) });
    case 'crew': return createCrewRuntime({ host, bridge, mcpSlots, defaultCwd: cwd });
    case 'codex': return new CodexRuntime({ host, bridge, mcpSlots, spawnEnv: () => process.env });
    case 'claude': return new ClaudeRuntime({ ...claudeAdapterOptions({ host, spawnEnv: () => process.env }), bridge, mcpSlots });
  }
}

/** The runtime, or why there is none to run. */
function construct(name: RuntimeName, host: RuntimeHost, mcpSlots: McpSlotProvider, cwd: string, engine?: string):
  { runtime?: AgentRuntime } & RuntimeAvailability {
  let runtime: AgentRuntime;
  try {
    runtime = buildRuntime(name, host, mcpSlots, cwd, engine);
  } catch (error) {
    if (error instanceof ClaudeSdkMissingError) return { available: false, detail: error.message };
    throw error;
  }
  if (name === 'claude') {
    // The adapter loads its optional peer at the first session; tell now.
    try {
      createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    } catch {
      return { runtime, available: false, detail: 'the optional peer @anthropic-ai/claude-agent-sdk is not installed' };
    }
  }
  return { runtime, ...(runtime.checkAvailability?.() ?? { available: true }) };
}

interface TurnResult {
  text: string;
  stopReason?: string;
  error?: string;
  hostEvents: string[];
  permissions: number;
  cancelAck?: CancelAck | void;
}

/**
 * Sends one prompt and reads its events to the end. A permission request is
 * answered allow_once when `allow` says so, else reject_once; a question is
 * skipped. With cancelOnFirstChunk the turn is cancelled at its first text.
 */
async function turn(session: AgentSession, prompt: string, options: {
  allow: (request: PermissionRequest) => boolean;
  cancelOnFirstChunk?: boolean;
}): Promise<TurnResult> {
  const result: TurnResult = { text: '', hostEvents: [], permissions: 0 };
  let cancelled = false;
  try {
    for await (const event of session.send(prompt)) {
      if (event.kind === 'chunk') {
        result.text += event.text;
        if (options.cancelOnFirstChunk && !cancelled) {
          cancelled = true;
          result.cancelAck = await session.cancel();
        }
      } else if (event.kind === 'permission_request') {
        result.permissions += 1;
        const answer = options.allow(event) ? 'allow_once' : 'reject_once';
        const option = event.options.find((candidate) => candidate.kind === answer);
        if (option) session.respondToPermission?.(event.requestId, option.optionId);
        else if (session.cancelPermission) session.cancelPermission(event.requestId);
        else session.respondToPermission?.(event.requestId, 'reject_once');
        print({ event: 'permission', title: event.title.slice(0, 120), answer: option ? answer : 'cancelled' });
      } else if (event.kind === 'user_input_request') {
        session.skipUserInput?.(event.requestId);
      } else if (event.kind === 'host_event') {
        result.hostEvents.push(event.type);
      } else if (event.kind === 'runtime_error') {
        result.error ??= event.error;
      } else if (event.kind === 'turn_end') {
        result.stopReason = event.stopReason;
      }
    }
  } catch (error) {
    result.error ??= message(error);
  }
  return result;
}

const mentions = (request: PermissionRequest, pattern: RegExp) => pattern.test(`${request.title}\n${request.detail ?? ''}`);
const count = (events: string[], type: string) => events.filter((event) => event === type).length;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      runtime: { type: 'string' },
      engine: { type: 'string' },
      approval: { type: 'string', default: 'deny' },
      cwd: { type: 'string' },
      'timeout-ms': { type: 'string', default: '420000' },
      check: { type: 'boolean', default: false },
    },
  });
  const requested = values.runtime ?? process.env.EXAMPLE_RUNTIME ?? 'kiro';
  const names: readonly RuntimeName[] = requested === 'all' && values.check ? RUNTIMES
    : RUNTIMES.filter((name) => name === requested);
  const timeoutMs = Number(values['timeout-ms']);
  if (names.length === 0 || !['allow', 'deny'].includes(values.approval) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    print({ step: 'usage', ok: false, detail: 'see the head of minimal-server-host.ts' });
    return 1;
  }

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-example-')));
  const cwd = values.cwd ? realpathSync(values.cwd) : work;
  const dataDir = join(work, 'data');
  mkdirSync(dataDir);
  // The manager and every adapter get this one host object (not a copy):
  // the manager reads the session directory behind host.sessions. Kiro v3
  // chat sessions share one MCP URL per cwd and name their session in every
  // host tool call; the default prompt port ends each of their turns with
  // the id to pass (ports.prompt.mcpSessionReminder replaces that text).
  const host = createDefaultHost({ principal: 'example', dataDir, permissionMode: 'ask', logLevel: 'warn' });
  const manager = createRuntimeManager({ host });
  // basePath /api/mcp gives slots http://127.0.0.1:<port>/api/mcp/<id>, the
  // one shape Crew's App relay accepts; the other runtimes take any.
  const mcpHost = createMcpHost<McpSlot>({ basePath: '/api/mcp', serverName: 'example-host' });
  const token = `HostWord${randomInt(100_000, 1_000_000)}`;
  mcpHost.registerTool({
    name: 'example_token',
    description: "Returns this conversation's code word, a made-up word for a test (not a secret).",
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, ctx) {
      // Reaches the session's event stream as a host_event.
      ctx.sink.emit({ type: 'example_token_read', payload: { nodeId: ctx.slot.binding.nodeId } });
      return { content: [{ type: 'text', text: token }] };
    },
  });

  const runtimes: AgentRuntime[] = [];
  let session: AgentSession | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    // Runtimes first: the slot provider is used only while mcpHost is open.
    await Promise.allSettled(runtimes.map((runtime) => runtime.shutdown()));
    await mcpHost.close(); // closes its listener too
    rmSync(work, { recursive: true, force: true });
  })();
  const timer = setTimeout(() => {
    print({ step: 'timeout', ok: false, timeoutMs });
    setTimeout(() => process.exit(1), 15_000).unref();
    void Promise.resolve(session?.cancel()).catch(() => {}).then(cleanup).finally(() => process.exit(1));
  }, timeoutMs);

  try {
    const listener = await mcpHost.listen();
    if (new URL(listener.baseUrl).hostname !== '127.0.0.1') throw new Error('the MCP host does not listen on loopback');
    const mcpSlots = createMcpSlotProvider(mcpHost);
    let ready: ({ runtime?: AgentRuntime } & RuntimeAvailability) | undefined;
    for (const name of names) {
      ready = construct(name, host, mcpSlots, cwd, values.engine);
      if (ready.runtime) {
        manager.register(ready.runtime);
        runtimes.push(ready.runtime);
      }
      // The base URL only: a slot's URL is its capability, kept out of logs.
      print({ step: 'ready', runtime: name, baseUrl: listener.baseUrl, available: ready.available, ...(ready.detail ? { detail: ready.detail } : {}) });
    }
    if (values.check) return 0;
    const runtime = ready?.runtime;
    if (!runtime || !ready?.available) return 2;

    let failed = false;
    const step = (name: string, ok: boolean, details: Record<string, unknown> = {}) => {
      print({ step: name, ok, ...details });
      if (!ok) failed = true;
    };
    const nodeId = `example-${randomUUID()}`;
    const owner = interactiveOwner(nodeId);
    session = await runtime.newSession({ sessionId: nodeId, cwd, owner, enableFollowUps: false });

    // 1. The host's tool. Allowed: that tool, and the listing a relay (Crew's
    //    App) makes before it calls one.
    const tool = await turn(session, PROMPTS.tool, { allow: (request) => mentions(request, /example_token|list_tools/) });
    step('tool', tool.text.includes(token) && count(tool.hostEvents, 'example_token_read') > 0 && !tool.error, {
      hostEvents: count(tool.hostEvents, 'example_token_read'), permissions: tool.permissions, stopReason: tool.stopReason, error: tool.error,
    });

    // 2. An approval: the agent asks to write a file in cwd.
    const file = join(cwd, 'example-approval.txt');
    rmSync(file, { force: true });
    const allow = values.approval === 'allow';
    const approval = await turn(session, PROMPTS.approval, { allow: () => allow });
    const written = existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
    step('approval', approval.permissions > 0 && (allow ? written === 'example-approval' : written === null), {
      approval: values.approval, permissions: approval.permissions, fileWritten: written !== null, stopReason: approval.stopReason,
    });
    rmSync(file, { force: true });

    // 3. A cancel at the first text of a long answer.
    const cancel = await turn(session, PROMPTS.count, { allow: () => false, cancelOnFirstChunk: true });
    const ack = cancel.cancelAck;
    step('cancel', !!ack && ack.acknowledged && cancel.stopReason === 'cancelled', {
      acknowledged: ack ? ack.acknowledged : null, stopReason: cancel.stopReason,
    });

    // 4. A native resume in this process: release the session, then load it
    //    from what the host kept. The default host keeps it in memory; a host
    //    that resumes after a restart persists it (ports.bindings).
    if (session.nativeSessionId) host.bindings.recordNativeSessionId(owner, session.nativeSessionId);
    const nativeEngine = session.nativeEngine;
    await runtime.releaseSession(session.id, owner);
    session = undefined;
    const binding = host.bindings.nodeBinding(nodeId);
    const nativeId = runtime.resumeTokenFromBinding
      ? runtime.resumeTokenFromBinding(binding)
      : binding?.acp_session_id ?? binding?.external_session_id ?? null;
    try {
      if (!runtime.loadSession || !nativeId) throw new Error('nothing to resume');
      session = await runtime.loadSession({ sessionId: nodeId, nodeId, cwd, owner, nativeEngine, enableFollowUps: false });
      step('resume', (session.nativeSessionId ?? session.id) === nativeId);
    } catch (error) {
      step('resume', false, { error: message(error) });
    }
    if (session) {
      // Answered from the resumed context: no tool call this time.
      const recall = await turn(session, PROMPTS.recall, { allow: () => false });
      step('resume-context', recall.text.includes(token) && count(recall.hostEvents, 'example_token_read') === 0 && !recall.error, {
        hostEvents: count(recall.hostEvents, 'example_token_read'), stopReason: recall.stopReason, error: recall.error,
      });
    } else {
      step('resume-context', false, { error: 'no resumed session' });
    }
    return failed ? 1 : 0;
  } finally {
    clearTimeout(timer);
    await cleanup();
  }
}

main().then((code) => {
  process.exitCode = code;
  // An agent process that outlives its shutdown must not keep this one alive.
  setTimeout(() => process.exit(code), 5_000).unref();
}, (error: unknown) => {
  print({ step: 'error', ok: false, error: message(error) });
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 5_000).unref();
});
