/**
 * Opt-in native recovery probe. First run probe-kiro-cancel.ts --http, then:
 * node --require ts-node/register scripts/probe-kiro-native-resume.ts --fixture /tmp/... --model claude-opus-4.6 --alternate-model claude-sonnet-4.6
 * Run from backend with Node 22+. Uses only the disposable probe's native
 * session, a new SQLite directory, and separate disposable backend processes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';

const { values } = parseArgs({ options: {
  fixture: { type: 'string' }, model: { type: 'string' }, 'alternate-model': { type: 'string' }, server: { type: 'boolean' },
} });

async function serve() {
  const directory = values.fixture!;
  const { AcpClient } = await import('../src/services/acpClient');
  const { KiroRuntime } = await import('../src/agents/kiro/KiroRuntime');
  const { registerRuntime } = await import('../src/agents/registry');
  const { ChatManager } = await import('../src/services/chatManager');
  const { setupMichiRoutes } = await import('../src/routes/michi');
  const { initDb, closeDb, getDb } = await import('../src/services/db');
  const { default: express } = await import('express');
  const wire: unknown[] = [];
  const prototype = AcpClient.prototype as any;
  const send = prototype.send;
  prototype.send = async function (method: string, params: any, ...rest: any[]) {
    wire.push({ method, sessionId: params?.sessionId, modelId: params?.modelId, acpPid: this.proc?.pid });
    return send.call(this, method, params, ...rest);
  };
  delete process.env.MICHI_CLOUD;
  initDb();
  const original = JSON.parse(fs.readFileSync(path.join(directory, 'evidence.json'), 'utf8'));
  getDb().prepare('INSERT OR IGNORE INTO workspaces (id,name,cwd,created_at,updated_at) VALUES (?,?,?,1,1)').run('probe-ws', 'Native resume probe', directory);
  getDb().prepare("INSERT OR IGNORE INTO nodes (id,workspace_id,title,kind,status,minimized,spawned_by_agent,created_at,acp_session_id,runtime_id,model_id,current_mode_id) VALUES ('probe-node','probe-ws','Native resume probe','chat','idle',0,0,1,?,'kiro',?,'michi-cancel-probe')").run(original.checks.sessionId, values.model!);
  // A second node exercises switching to another native session and back.
  getDb().prepare("INSERT OR IGNORE INTO nodes (id,workspace_id,title,kind,status,minimized,spawned_by_agent,created_at,runtime_id,model_id) VALUES ('other-node','probe-ws','Other probe','chat','idle',0,0,1,'kiro',?)").run(values.model!);
  const runtime = new KiroRuntime({} as any, undefined, 0, directory);
  registerRuntime(runtime);
  const app = express();
  app.use(express.json());
  app.use('/api', setupMichiRoutes(new ChatManager(runtime, directory)));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.send?.({ ready: true, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, pid: process.pid });
  process.once('message', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown();
    closeDb();
    process.send?.({ wire, pid: process.pid });
    process.disconnect?.();
  });
}

async function main() {
  assert.ok(values.fixture && values.model && values['alternate-model'], '--fixture, --model and --alternate-model are required');
  const fixture = fs.realpathSync(values.fixture);
  const initial = JSON.parse(fs.readFileSync(path.join(fixture, 'evidence.json'), 'utf8'));
  assert.equal(initial.success, true, 'requires a successful disposable cancel probe');
  assert.ok(fs.existsSync(path.join(fixture, '.kiro', 'agents', 'michi-cancel-probe.json')));
  const expected = [...new Set<string>(initial.turns[2].answer.match(/(?:INTERRUPTED-TOOL|INTERRUPTED|MEMORY|TOOL)-[a-f0-9-]{36}/g))];
  assert.equal(expected.length, 4);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-native-restart-'));
  const evidence: { success: boolean; sessionId: string; processes: unknown[]; decisions: any[]; recall: unknown[]; error?: string } = {
    success: false, sessionId: initial.checks.sessionId, processes: [], decisions: [], recall: [],
  };
  let child: ChildProcess | undefined;
  let base = '';
  let wireResult: Promise<unknown> | undefined;
  let exited: Promise<unknown> | undefined;
  async function start() {
    child = fork(__filename, ['--server', '--fixture', fixture, '--model', values.model!], {
      execArgv: ['--require', 'ts-node/register'],
      env: { ...process.env, MICHI_DATA_DIR: path.join(directory, 'data'), TS_NODE_PROJECT: path.resolve(__dirname, '../tsconfig.json') },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const current = child;
    exited = once(current, 'exit');
    const [ready] = await Promise.race([once(current, 'message'), exited.then(() => { throw new Error('probe backend exited before readiness'); })]);
    assert.equal(ready.ready, true);
    base = ready.url;
    wireResult = once(current, 'message').then(([result]) => result);
  }
  async function stop() {
    if (!child) return;
    child.send({ stop: true });
    evidence.processes.push(await wireResult);
    await exited;
    child = undefined;
  }
  async function ensure(nodeId = 'probe-node', modelId?: string, strategy = 'live') {
    const response = await fetch(`${base}/nodes/${nodeId}/ensure-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'probe-ws', cwd: fixture, runtimeId: 'kiro', modelId, modeId: 'michi-cancel-probe', enableFollowUps: false }),
    });
    const result = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(result));
    evidence.decisions.push(result);
    assert.equal(result.resumeStrategy, strategy);
    assert.equal(result.currentModeId, 'michi-cancel-probe');
    return result;
  }
  async function recall() {
    const response = await fetch(`${base}/chats/probe-node/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Without tools or files, return both conversation markers and the contents of both files you read earlier, including the interrupted turn. Return all four exact values and nothing else.' }),
    });
    assert.equal(response.status, 200);
    const { readSseStream } = await import('../../frontend/src/services/api/sseParser');
    let answer = '';
    let tools = 0;
    let done = false;
    await readSseStream(response.body!.getReader(), (event, data) => {
      const payload = JSON.parse(data);
      if (event === 'error') throw new Error(payload.message);
      if (event === 'chunk') answer += payload.text;
      if (event === 'tool_call') tools++;
      if (event === 'done') done = true;
    });
    evidence.recall.push({ answer, tools, done });
    assert.ok(done);
    assert.equal(tools, 0);
    for (const marker of expected) assert.ok(answer.includes(marker), 'native context lost a marker or tool result');
  }
  const timeout = setTimeout(() => { child?.kill('SIGTERM'); }, 240_000);
  try {
    await start();
    await ensure('probe-node', undefined, 'exact');
    await recall();
    await ensure('other-node', undefined, 'fresh');
    await ensure();
    await ensure('probe-node', values['alternate-model']);
    await recall();
    await stop();
    await start();
    const resumed = await ensure('probe-node', undefined, 'exact');
    assert.equal(resumed.modelId, values['alternate-model']);
    await recall();
    await stop();
    const processes = evidence.processes as Array<{ pid: number; wire: Array<{ method: string; sessionId?: string; acpPid?: number }> }>;
    assert.notEqual(processes[0].pid, processes[1].pid, 'must restart the actual backend process');
    const wire = processes.flatMap((entry) => entry.wire);
    assert.equal(wire.filter((entry) => entry.method === 'session/new').length, 1, 'only the other probe node may create a session');
    const loads = wire.filter((entry) => entry.method === 'session/load');
    assert.equal(loads.length, 2);
    assert.ok(loads.every((entry) => entry.sessionId === initial.checks.sessionId));
    assert.notEqual(loads[0].acpPid, loads[1].acpPid, 'must restart the actual ACP process');
    assert.ok(wire.filter((entry) => entry.method === 'session/prompt').every((entry) => entry.sessionId === initial.checks.sessionId));
    evidence.success = true;
    console.log('PASS: cold native restore, switch away/back, model switch, backend/ACP restart and four-value tool-free recall.');
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearTimeout(timeout);
    if (child?.connected) await stop();
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(`Native resume evidence: ${path.join(directory, 'evidence.json')}`);
  }
}

(values.server ? serve() : main()).catch((error) => { console.error(error); process.exitCode = 1; });
