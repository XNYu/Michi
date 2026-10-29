import './claudeSdkFixture';
/**
 * A scripted Claude CLI at the SDK boundary for ClaudeSession tests: it
 * records every SDK message the session writes and sends the frames a test
 * scripts. The frames follow what the installed CLI (2.1.312, SDK 0.3.306)
 * sent in the standalone probes under .probe/claude.
 */
import { EventEmitter, PassThrough } from 'node:stream';
import { claudeTestOptions } from './claudeTestOptions';
import { subagentSink } from './hostSinks';
import { BackgroundSubagentRegistry } from '../../src/services/backgroundSubagentRegistry';
import type { NormalizedEvent } from '../../src/services/chatEvents';

export class ScriptedClaudeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  /** Every SDK message the session wrote. */
  readonly lines: Array<Record<string, any>> = [];
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) this.lines.push(JSON.parse(line));
    });
  }
  kill(signal?: string): boolean {
    this.killed = true;
    process.nextTick(() => this.emit('exit', signal === 'SIGKILL' ? 137 : 0, null));
    return true;
  }
  send(envelope: object): void { this.stdout.push(JSON.stringify(envelope) + '\n'); }
  init(capabilities = ['msg_lifecycle_v1', 'interrupt_receipt_v1'], permissionMode?: string): void {
    this.send({ type: 'system', subtype: 'init', session_id: 'ext-steer-1', capabilities, ...(permissionMode ? { permissionMode } : {}) });
  }
  lifecycle(uuid: string, state: string): void {
    this.send({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: `l-${state}-${uuid}`, session_id: 'ext-steer-1' });
  }
  chunk(text: string): void {
    this.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  }
  status(permissionMode: string): void {
    this.send({ type: 'system', subtype: 'status', status: null, permissionMode, session_id: 'ext-steer-1' });
  }
  result(subtype = 'success', usage: Record<string, number> = { input_tokens: 10, output_tokens: 5 }): void {
    this.send({ type: 'result', subtype, usage });
  }
}

export const scriptedChildren: ScriptedClaudeChild[] = [];

export function stubClaudeSpawn(): void {
  scriptedChildren.length = 0;
  const mod = require('michi-runtime/internal/adapters/claude/claudeBinary');
  mod._origSpawnClaude = mod._origSpawnClaude ?? mod.spawnClaude;
  mod._origPreflight = mod._origPreflight ?? mod.preflightClaudeAuth;
  mod.preflightClaudeAuth = () => {};
  mod.spawnClaude = (args: unknown) => {
    const child = new ScriptedClaudeChild();
    (child as any).spawnArgs = args;
    scriptedChildren.push(child);
    return child;
  };
  const repo = require('../../src/services/dbRepository');
  repo._origSetNode = repo._origSetNode ?? repo.setNodeExternalSessionId;
  repo._origGetNode = repo._origGetNode ?? repo.getNode;
  repo.setNodeExternalSessionId = () => {};
  repo.getNode = () => undefined;
}

export function restoreClaudeSpawn(): void {
  const mod = require('michi-runtime/internal/adapters/claude/claudeBinary');
  if (mod._origSpawnClaude) { mod.spawnClaude = mod._origSpawnClaude; delete mod._origSpawnClaude; }
  if (mod._origPreflight) { mod.preflightClaudeAuth = mod._origPreflight; delete mod._origPreflight; }
  const repo = require('../../src/services/dbRepository');
  if (repo._origSetNode) { repo.setNodeExternalSessionId = repo._origSetNode; delete repo._origSetNode; }
  if (repo._origGetNode) { repo.getNode = repo._origGetNode; delete repo._origGetNode; }
}

/** A spawned session on a scripted child, and the SDK query fake to script its controls. */
export async function newScriptedSession(overrides: Record<string, unknown> = {}, beforeSpawn?: (session: any) => Promise<void>) {
  delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
  const { ClaudeSession } = require('michi-runtime/internal/adapters/claude/ClaudeSession') as typeof import('michi-runtime/internal/adapters/claude/ClaudeSession');
  const session = new ClaudeSession('node-steer', {
    nodeId: 'node-steer', cwd: '/tmp/test-cwd', workspaceId: null,
    mcpRegistry: {
      create: () => ({ slotId: 'slot-1', workspaceId: null }),
      dispose: async () => {},
      endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }),
    } as any,
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any,
    options: claudeTestOptions(),
    backgroundSubagents: subagentSink(new BackgroundSubagentRegistry({ resolveWorkspace: () => 'ws-test' })),
    ...overrides,
  });
  await beforeSpawn?.(session);
  await session.spawnFresh();
  const child = scriptedChildren.at(-1)!;
  const query = (session as any).transport.query as Record<string, unknown>;
  return { session, child, query };
}

export async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export function startScriptedTurn(session: any, text: string) {
  const events: NormalizedEvent[] = [];
  const done = (async () => { for await (const event of session.send(text)) events.push(event); })();
  return { events, done };
}

/** A running turn whose CLI already reported init (and so its capabilities). */
export async function runningScriptedTurn(session: any, child: ScriptedClaudeChild, capabilities?: string[], permissionMode?: string) {
  const sent = child.lines.length;
  const turn = startScriptedTurn(session, 'first');
  await until(() => child.lines.length > sent, 'the prompt');
  child.init(capabilities, permissionMode);
  await until(() => session.nativeSessionId === 'ext-steer-1', 'init');
  return turn;
}
