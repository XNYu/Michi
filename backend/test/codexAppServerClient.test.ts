import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAppServerClient, CodexRpcTimeoutError } from '../src/agents/codex/CodexAppServerClient';

/** Minimal ChildProcess stand-in: scriptable stdout, captured stdin. */
function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.written = '';
  child.stdin.on('data', (d: Buffer) => {
    child.written += d.toString();
  });
  child.kill = () => {
    child.emit('exit', 0);
  };
  return child;
}

function makeClient(child: any, overrides: Record<string, unknown> = {}) {
  return new CodexAppServerClient({
    spawnFn: () => child,
    rpcTimeoutMs: 200,
    initTimeoutMs: 200,
    ...overrides,
  });
}

/** Auto-answer initialize so ensureStarted resolves.
 *  Responds on the first `data` event from stdin that contains an initialize
 *  request. Using a stream `data` event (rather than a polled interval) keeps
 *  the approach synchronous with the event loop and avoids unref-related
 *  cancellations in node:test.
 */
function autoInit(child: any) {
  let buf = '';
  let done = false;
  child.stdin.on('data', (d: Buffer) => {
    if (done) return;
    buf += d.toString();
    const m = buf.match(/\{"jsonrpc":"2\.0","id":(\d+),"method":"initialize"/);
    if (m) {
      done = true;
      const id = Number(m[1]);
      child.stdout.write(JSON.stringify({ id, result: { userAgent: 'fake' } }) + '\n');
    }
  });
}

test('request correlates responses by id, including across split chunks', async () => {
  const child = fakeChild();
  autoInit(child);
  const client = makeClient(child);
  await client.ensureStarted();

  const p = client.request('model/list', {});
  // find the outgoing id, then answer it SPLIT across two stdout chunks
  const sent = child.written
    .split('\n')
    .filter(Boolean)
    .map((l: string) => JSON.parse(l));
  const req = sent.find((o: any) => o.method === 'model/list');
  const resp = JSON.stringify({ id: req.id, result: { data: [{ id: 'gpt-5.5' }] } }) + '\n';
  child.stdout.write(resp.slice(0, 10));
  child.stdout.write(resp.slice(10));
  const result: any = await p;
  assert.equal(result.data[0].id, 'gpt-5.5');
  await client.shutdown();
});

test('request rejects with CodexRpcTimeoutError when no response arrives', async () => {
  const child = fakeChild();
  autoInit(child);
  const client = makeClient(child);
  await client.ensureStarted();
  await assert.rejects(client.request('thread/start', {}), CodexRpcTimeoutError);
  await client.shutdown();
});

test('notifications route to thread-scoped handlers; unknown methods are ignored', async () => {
  const child = fakeChild();
  autoInit(child);
  const client = makeClient(child);
  await client.ensureStarted();
  const seen: string[] = [];
  client.onNotification('t-1', (method) => {
    seen.push(method);
  });
  child.stdout.write(
    JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 't-1', delta: 'x' },
    }) + '\n',
  );
  child.stdout.write(
    JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 't-OTHER', delta: 'y' },
    }) + '\n',
  );
  child.stdout.write(
    JSON.stringify({
      method: 'totally/unknown/notification',
      params: { threadId: 't-1' },
    }) + '\n',
  );
  child.stdout.write('not json at all\n');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ['item/agentMessage/delta', 'totally/unknown/notification']);
  await client.shutdown();
});

test('server requests (string AND numeric ids) dispatch and respond is wired back', async () => {
  const child = fakeChild();
  autoInit(child);
  const client = makeClient(child);
  await client.ensureStarted();
  client.onServerRequest((method, _params, respond) => {
    respond({ decision: 'accept' });
  });
  child.stdout.write(
    JSON.stringify({
      id: 'req-abc',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't-1' },
    }) + '\n',
  );
  child.stdout.write(
    JSON.stringify({
      id: 42,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 't-1' },
    }) + '\n',
  );
  await new Promise((r) => setTimeout(r, 20));
  const outs = child.written
    .split('\n')
    .filter(Boolean)
    .map((l: string) => JSON.parse(l));
  assert.ok(outs.some((o: any) => o.id === 'req-abc' && o.result?.decision === 'accept'));
  assert.ok(outs.some((o: any) => o.id === 42 && o.result?.decision === 'accept'));
  await client.shutdown();
});

test('daemon exit rejects pending requests and fires exit handlers', async () => {
  const child = fakeChild();
  autoInit(child);
  const client = makeClient(child, { rpcTimeoutMs: 5_000 });
  await client.ensureStarted();
  let exited = false;
  client.onExit(() => {
    exited = true;
  });
  const pending = client.request('thread/start', {});
  child.emit('exit', 1);
  await assert.rejects(pending, /exited/);
  assert.equal(exited, true);
  await client.shutdown();
});
