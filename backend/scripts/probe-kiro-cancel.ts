/**
 * Live, opt-in cancel/continue probe using the production ACP transport.
 * Run from the root:
 * npx ts-node --project backend/tsconfig.json backend/scripts/probe-kiro-cancel.ts
 * Add --http to exercise real HTTP routes, SQLite, ChatHub and KiroRuntime too.
 * Uses a temporary cwd/data dir and a restricted local agent. Does not open or
 * mutate existing Michi conversations. Requires an authenticated kiro-cli.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AcpClient, AcpUpdate } from '../src/services/acpClient';
import type { AddressInfo } from 'node:net';
import type { AgentToolBridge } from '../src/agents/toolBridge';

async function startHttpProbe(directory: string, client: AcpClient) {
  const { default: express } = await import('express');
  const { initDb, closeDb, getDb } = await import('../src/services/db');
  const { getNode } = await import('../src/services/dbRepository');
  const { KiroRuntime } = await import('../src/agents/kiro/KiroRuntime');
  const { registerRuntime } = await import('../src/agents/registry');
  const { setupMichiRoutes } = await import('../src/routes/michi');
  const { ChatManager } = await import('../src/services/chatManager');
  const { readSseStream } = await import('../../frontend/src/services/api/sseParser');
  delete process.env.MICHI_CLOUD;
  initDb();
  getDb().prepare('INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES (?,?,?,1,1)').run('probe-ws', 'Isolated cancel probe', directory);
  getDb().prepare("INSERT INTO nodes (id,workspace_id,title,kind,status,minimized,spawned_by_agent,created_at) VALUES ('probe-node','probe-ws','Cancel probe','chat','idle',0,0,1)").run();
  const runtime = new KiroRuntime({} as AgentToolBridge, undefined, 0, directory);
  // Attach the instrumented, already initialized client to the real pool.
  (runtime as any).pool.set(directory, client);
  registerRuntime(runtime);
  const app = express();
  app.use(express.json());
  app.use('/api', setupMichiRoutes(new ChatManager(runtime, directory)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let turnId = '';
  const decisions: unknown[] = [];
  async function post(endpoint: string, body: unknown) {
    const response = await fetch(`${base}${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text().catch(() => 'HTTP error'));
    return response;
  }
  return {
    decisions,
    getClient: () => runtime.getClient(directory),
    async ensure() {
      const result = await (await post('/nodes/probe-node/ensure-session', {
        workspaceId: 'probe-ws', cwd: directory, runtimeId: 'kiro', modeId: 'michi-cancel-probe', enableFollowUps: false,
      })).json() as { resumeStrategy: string };
      decisions.push(result);
      assert.equal(result.resumeStrategy, decisions.length === 1 ? 'fresh' : 'live');
      return getNode('probe-node')!.acp_session_id!;
    },
    async run(text: string, onUpdate: (update: AcpUpdate) => Promise<void>) {
      turnId = randomUUID();
      // Do not clone/read the streaming response before consuming its frames.
      const response = await fetch(`${base}/chats/probe-node/message`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, turnId }),
      });
      assert.equal(response.status, 200);
      assert.ok(response.body);
      await readSseStream(response.body.getReader(), async (event, data) => {
        const update = JSON.parse(data);
        if (event === 'error') throw new Error(update.message);
        if (event === 'chunk') await onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: update.text } });
        else if (event === 'done') await onUpdate({ sessionUpdate: 'turn_end', stopReason: update.stopReason });
        else await onUpdate({ ...update, sessionUpdate: event });
      });
    },
    async cancel() { await post('/chats/probe-node/cancel', { turnId }); },
    async shutdown() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown();
      closeDb();
    },
  };
}

async function main() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-cancel-')));
  process.env.MICHI_DATA_DIR = path.join(directory, 'data');
  fs.mkdirSync(path.join(directory, '.kiro', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(directory, '.kiro', 'agents', 'michi-cancel-probe.json'), JSON.stringify({
    name: 'michi-cancel-probe',
    description: 'Isolated cancel/continue verification',
    prompt: 'This is an isolated cancellation verification. Use only execute_bash, and only for the literal commands cat probe-secret.txt, cat cancel-secret.txt, and sleep 60 when the user requests them. Do not invoke subagents or other tools. The first message may include an app preamble ending with "The user will now speak." The text after that boundary is the actual user request, including any requested cat command. Read each requested file and remember the tool result.',
    tools: ['execute_bash'],
    allowedTools: ['execute_bash'],
    resources: [],
    includeMcpJson: false,
  }));
  const { AcpClient } = await import('../src/services/acpClient');
  const fault = process.argv.find((arg) => arg.startsWith('--fault='))?.slice('--fault='.length);
  const withPeer = process.argv.includes('--with-peer');
  assert.ok(!fault || fault === 'drop-completion' || fault === 'ignore-cancel');
  assert.ok(!fault || process.argv.includes('--http'), 'fault probes require the real HTTP/runtime recovery path');
  assert.ok(!withPeer || fault, 'peer safety probe requires fault injection');
  const client = new AcpClient(undefined, directory);
  const wire: Array<Record<string, unknown>> = [];
  // Instrument the actual stdio messages, not inferred session-file timestamps.
  const internals = client as any;
  const prototype = AcpClient.prototype as any;
  const originalSend = prototype.send;
  prototype.send = function(this: any, method: string, params: any, ...rest: any[]) {
    if (method === 'session/new' || method === 'session/load' || method === 'session/prompt') {
      wire.push({ direction: 'request', method, sessionId: params?.sessionId, pid: this.proc?.pid, at: Date.now() });
    }
    return originalSend.call(this, method, params, ...rest).then((result: any) => {
      wire.push({ direction: 'response', method, sessionId: result?.sessionId ?? params?.sessionId, stopReason: result?.stopReason, pid: this.proc?.pid, at: Date.now() });
      return result;
    });
  };
  let cancelledSid: string | undefined;
  let injected = false;
  const originalNotify = prototype.notify;
  prototype.notify = function(this: any, method: string, params: any) {
    wire.push({ direction: 'notification', method, sessionId: params?.sessionId, pid: this.proc?.pid, at: Date.now() });
    if (method === 'session/cancel') {
      cancelledSid = params.sessionId;
      if (fault === 'ignore-cancel' && !injected) { injected = true; return Promise.resolve(); }
    }
    return originalNotify.call(this, method, params);
  };
  const originalDispatch = prototype.dispatch;
  prototype.dispatch = function(this: any, message: any) {
    const pending = this.pending.get(message?.id);
    if (fault === 'drop-completion' && !injected && cancelledSid && pending?.sessionId === cancelledSid
      && pending.method === 'session/prompt' && ('result' in message || 'error' in message)) {
      injected = true;
      wire.push({ direction: 'fault', method: 'dropped-prompt-completion', sessionId: cancelledSid, at: Date.now() });
      return;
    }
    return originalDispatch.call(this, message);
  };
  const turns: Array<Record<string, unknown>> = [];
  const checks: Record<string, unknown> = {};
  let http: Awaited<ReturnType<typeof startHttpProbe>> | undefined;
  let peerSid: string | undefined;
  let peerTurn: Promise<void> | undefined;
  let failure: unknown;
  const timeout = setTimeout(() => { void client.shutdown(); }, 180_000);
  try {
    client.start();
    await client.initialize();
    if (process.argv.includes('--http')) http = await startHttpProbe(directory, client);
    const sessionId = http ? await http.ensure() : (await client.newSession()).sessionId;
    if (!http) await client.setMode(sessionId, 'michi-cancel-probe');
    const pid = internals.proc.pid;
    Object.assign(checks, { sessionId, pid, fault: fault ?? null });
    console.log(JSON.stringify({ directory, sessionId, pid }));
    const marker = `MEMORY-${randomUUID()}`;
    const toolMarker = `TOOL-${randomUUID()}`;
    const interruptedMarker = `INTERRUPTED-${randomUUID()}`;
    const interruptedToolMarker = `INTERRUPTED-TOOL-${randomUUID()}`;
    fs.writeFileSync(path.join(directory, 'probe-secret.txt'), toolMarker);
    fs.writeFileSync(path.join(directory, 'cancel-secret.txt'), interruptedToolMarker);
    async function turn(text: string, cancelOnTool = false) {
      const startedAt = Date.now();
      if (http && turns.length > 0) assert.equal(await http.ensure(), sessionId);
      const ensuredAt = Date.now();
      let firstChunkAt: number | undefined;
      let cancelledAt: number | undefined;
      let answer = '';
      let stopReason: string | undefined;
      let cancelled = false;
      const events: Array<Record<string, unknown>> = [];
      async function onUpdate(update: AcpUpdate) {
        const kind = update.sessionUpdate;
        events.push({ kind, status: update.status, title: update.title, detail: update.detail, at: Date.now(), contextUsagePercentage: update.contextUsagePercentage });
        if (kind === 'agent_message_chunk') {
          firstChunkAt ??= Date.now();
          for (const block of Array.isArray(update.content) ? update.content : [update.content]) {
            if (block?.type === 'text') answer += block.text;
          }
        }
        if (cancelOnTool && kind === 'tool_call' && String(update.title).includes('sleep 60') && !cancelled) {
          cancelled = true;
          if (withPeer) {
            peerSid = (await client.newSession()).sessionId;
            await client.setMode(peerSid, 'michi-cancel-probe');
            let ready!: () => void;
            let failed!: (error: unknown) => void;
            const peerStarted = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
            peerTurn = (async () => {
              for await (const event of client.prompt(peerSid!, 'Run sleep 60 using execute_bash, then reply DONE.')) {
                if (event.sessionUpdate === 'tool_call' && String(event.title).includes('sleep 60')) ready();
              }
            })();
            void peerTurn.catch(failed);
            await peerStarted;
          }
          cancelledAt = Date.now();
          console.log('[probe] cancelling active tool call');
          if (http) await http.cancel();
          else await client.cancel(sessionId);
        }
        if (kind === 'turn_end') stopReason = update.stopReason;
      }
      if (http) await http.run(text, onUpdate);
      else for await (const update of client.prompt(sessionId, text)) await onUpdate(update);
      const result = { answer, stopReason, cancelled, events, timing: {
        ensureMs: ensuredAt - startedAt, firstChunkMs: firstChunkAt === undefined ? null : firstChunkAt - startedAt,
        cancelToDoneMs: cancelledAt === undefined ? null : Date.now() - cancelledAt, totalMs: Date.now() - startedAt,
      } };
      turns.push(result);
      console.log(JSON.stringify({ turn: turns.length, answer, stopReason, cancelled }));
      return result;
    }
    const initial = await turn(`Remember this private marker for our conversation: ${marker}. Read probe-secret.txt using execute_bash (cat probe-secret.txt), remember its contents too, then reply just READY.`);
    assert.ok(initial.events.some((event) => event.kind === 'tool_call' && String(event.title).includes('cat probe-secret.txt')), 'initial turn must actually read its fixture');
    const interrupted = await turn(`Remember another marker: ${interruptedMarker}. First read cancel-secret.txt using execute_bash with "cat cancel-secret.txt" and remember the contents. Then in a SEPARATE tool call run "sleep 60". After it finishes, reply FINISHED.`, true);
    assert.equal(interrupted.cancelled, true, 'must cancel during an actual tool call');
    assert.equal(interrupted.stopReason, 'cancelled');
    assert.ok(interrupted.events.some((event) => event.kind === 'tool_call_update'
      && event.status === 'completed' && String(event.title).includes('cat cancel-secret.txt')),
    'cancelled turn must finish reading its fixture before cancellation');
    // Delete only this generated fixture: recall must come from native context.
    fs.unlinkSync(path.join(directory, 'probe-secret.txt'));
    fs.unlinkSync(path.join(directory, 'cancel-secret.txt'));
    const recallPrompt = 'Without using any tools or files, return both conversation markers and the contents of both files you read earlier, including the interrupted turn. Return all four exact values and nothing else.';
    if (withPeer) {
      await assert.rejects(turn(recallPrompt), /another task/);
      assert.equal((http!.getClient() as any).proc.pid, pid, 'blocked recovery must not restart the healthy peer process');
      checks.healthyPeerProtected = true;
      checks.peerSessionId = peerSid;
      await client.cancel(peerSid!);
      await peerTurn;
      client.destroySession(peerSid!);
    }
    const recall = await turn(recallPrompt);
    assert.ok(recall.answer.includes(marker), 'pre-cancel user marker must survive');
    assert.ok(recall.answer.includes(toolMarker), 'pre-cancel tool result must survive');
    if (fault !== 'ignore-cancel') {
      assert.ok(recall.answer.includes(interruptedMarker), 'cancelled-turn user marker must survive');
      assert.ok(recall.answer.includes(interruptedToolMarker), 'cancelled-turn completed tool result must survive');
    }
    assert.equal(recall.events.filter((event) => event.kind === 'tool_call').length, 0,
      'recall must not use tools to reconstruct memory');
    const finalPid = (http?.getClient() as any ?? client).proc?.pid;
    if (!fault) assert.equal(finalPid, pid, 'normal cancel must not restart the ACP process');
    else {
      assert.equal(injected, true, 'the fault must actually have been injected');
      assert.notEqual(finalPid, pid, 'watchdog recovery must replace the fenced process');
      assert.ok(recall.events.some((event) => event.kind === 'retry_start'));
      assert.ok(recall.events.some((event) => event.kind === 'retry_end'));
      assert.ok(interrupted.timing.cancelToDoneMs! < 7_000, 'cancel should settle near its 5s deadline');
      assert.equal(await http!.ensure(), sessionId, 'post-recovery binding must remain live');
    }
    const prompts = wire.filter((item) => item.direction === 'request' && item.method === 'session/prompt' && item.sessionId === sessionId);
    assert.equal(prompts.length, 3);
    assert.ok(prompts.every((item) => item.sessionId === sessionId));
    assert.equal(wire.filter((item) => item.direction === 'request' && item.method === 'session/new').length, withPeer ? 2 : 1);
    const loads = wire.filter((item) => item.direction === 'request' && item.method === 'session/load');
    assert.equal(loads.length, fault ? 1 : 0);
    assert.ok(loads.every((item) => item.sessionId === sessionId));
    Object.assign(checks, { finalPid, promptSessionIds: prompts.map((item) => item.sessionId),
      newSessions: withPeer ? 2 : 1, loadedSessions: loads.length, priorMemoryPreserved: true,
      interruptedUserMemoryPreserved: recall.answer.includes(interruptedMarker),
      interruptedToolMemoryPreserved: recall.answer.includes(interruptedToolMarker), recallToolCalls: 0 });
    console.log(`[probe] PASS: ${fault ?? 'normal cancel'}, original ACP session, prior user/tool memory preserved`);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    clearTimeout(timeout);
    await http?.shutdown();
    await client.shutdown();
    await peerTurn?.catch(() => {});
    prototype.send = originalSend;
    prototype.notify = originalNotify;
    prototype.dispatch = originalDispatch;
    const evidencePath = path.join(directory, 'evidence.json');
    fs.writeFileSync(evidencePath, JSON.stringify({ success: !failure, error: failure instanceof Error ? failure.message : undefined, checks, decisions: http?.decisions, wire, turns }, null, 2));
    console.log(`[probe] evidence: ${evidencePath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
