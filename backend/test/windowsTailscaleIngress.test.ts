import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { createServer as createHttpServer, request, type IncomingHttpHeaders } from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { WebSocket } from 'ws';
import type { StreamTransportResponse } from 'michi-shared';
import { createMobileAccessGateway } from '../src/services/mobileAccessGateway';
import { createStreamTransport } from '../src/services/streamTransport';
import { createLocalOriginGuard } from '../src/routes/middleware/localControl';
import { TailscaleMobileAccess, foreignIngressRoute } from '../src/services/tailscaleMobileAccess';
import {
  createWindowsServeVerifier, parseWindowsIngressSnapshot, powershellIngressProbe, resolveWindowsTailscaleBinary,
  serviceExecutable, windowsConnectionRefusal, windowsIngressScript, windowsPowerShellPath, windowsTailscaledFor,
  type WindowsIngressProbe, type WindowsIngressSnapshot,
} from '../src/services/windowsTailscaleIngress';

// Windows APIs are simulated with fixtures on this host. These tests verify
// Michi's decisions over the snapshot shape; they are not Windows verification.
const CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const DAEMON = 'C:\\Program Files\\Tailscale\\tailscaled.exe';
const SERVICE = 900, CHILD = 901, LOCAL_APP = 4242;
const SECRET = 'a'.repeat(16) + '0123456789abcdef0123456789abcdef';
const origin = 'https://michi.tail123.ts.net';
const owner = { 'tailscale-user-login': 'owner@example.com', origin };

async function until(predicate: () => boolean, attempts = 400) {
  for (let i = 0; i < attempts; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.ok(predicate(), 'condition did not become true');
}
const iso = (ms: number) => new Date(ms).toISOString();

function snapshotFor(gatewayPort: number, clients: Array<{ port: number; pid: number }>): WindowsIngressSnapshot {
  const hourAgo = Date.now() - 3_600_000;
  const service = { state: 'Running', pid: SERVICE, path: `"${DAEMON}"`, account: 'LocalSystem', type: 'Own Process' };
  return {
    start: iso(Date.now()), service, serviceAfter: { ...service },
    connections: clients.flatMap(client => [
      { localPort: client.port, remotePort: gatewayPort, pid: client.pid, state: 'Established' },
      { localPort: gatewayPort, remotePort: client.port, pid: process.pid, state: 'Established' },
    ]),
    processes: [
      { pid: SERVICE, parent: 640, name: 'tailscaled.exe', created: iso(hourAgo), path: null },
      { pid: CHILD, parent: SERVICE, name: 'tailscaled.exe', created: iso(hourAgo + 1000), path: null },
      { pid: LOCAL_APP, parent: 3000, name: 'node.exe', created: iso(hourAgo), path: 'C:\\Users\\someone\\node.exe' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Decision over one OS snapshot
// ---------------------------------------------------------------------------

test('Windows decision accepts only the running Tailscale service process tree for this exact loopback tuple', () => {
  const acceptedAt = Date.now() - 50;
  const context = { gatewayPort: 50000, clientPort: 50001, ownPid: process.pid, acceptedAt, expectedBinary: DAEMON };
  const base = () => snapshotFor(50000, [{ port: 50001, pid: CHILD }]);
  assert.equal(windowsConnectionRefusal(base(), context), null);
  // A future tailscaled that dials from the SCM process itself is also the service.
  const inProcess = base(); inProcess.connections[0].pid = SERVICE;
  assert.equal(windowsConnectionRefusal(inProcess, context), null);

  const refused: Array<[string, (s: WindowsIngressSnapshot) => void]> = [
    ['forged headers from another local process', s => { s.connections[0].pid = LOCAL_APP; }],
    ['service not visible', s => { s.service = null; }],
    ['service stopped', s => { s.service!.state = 'Stopped'; }],
    ['service restarted during the snapshot', s => { s.serviceAfter!.pid = 950; }],
    ['service not LocalSystem', s => { s.service!.account = 'NT AUTHORITY\\LocalService'; }],
    ['shared service host', s => { s.service!.type = 'Share Process'; }],
    ['unquoted service path with spaces', s => { s.service!.path = DAEMON; }],
    ['service from another directory', s => { s.service!.path = '"C:\\Users\\someone\\tailscaled.exe"'; }],
    ['missing client row', s => { s.connections.shift(); }],
    ['duplicate client rows', s => { s.connections.push({ ...s.connections[0] }); }],
    ['TIME_WAIT row without owner', s => { s.connections[0].pid = 0; s.connections[0].state = 'TimeWait'; }],
    ['server socket owned by another process', s => { s.connections[1].pid = LOCAL_APP; }],
    ['peer PID reused after accept', s => { s.processes[1].created = iso(acceptedAt + 10); }],
    ['parent PID reused after the peer started', s => { s.processes[1].created = iso(Date.parse(s.processes[0].created!) - 1000); }],
    ['missing creation time', s => { s.processes[1].created = null; }],
    ['tailscaled-named child of another parent', s => { s.processes[1].parent = 3000; }],
    ['visible image path mismatch', s => { s.processes[1].path = 'C:\\Users\\someone\\tailscaled.exe'; }],
    ['duplicate process facts', s => { s.processes.push({ ...s.processes[1] }); }],
    ['snapshot taken before accept', s => { s.start = iso(acceptedAt - 5000); }],
  ];
  for (const [label, mutate] of refused) {
    const snapshot = base(); mutate(snapshot);
    assert.notEqual(windowsConnectionRefusal(snapshot, context), null, label);
  }
});

test('Windows snapshot parsing is strict and tolerates PowerShell single-object collections', () => {
  const raw = snapshotFor(50000, [{ port: 50001, pid: CHILD }]) as unknown as Record<string, unknown>;
  const single = { ...raw, connections: (raw.connections as unknown[])[0], processes: (raw.processes as unknown[])[1] };
  const parsed = parseWindowsIngressSnapshot(single);
  assert.equal(parsed.connections.length, 1); assert.equal(parsed.processes.length, 1);
  for (const invalid of [null, [], { ...raw, start: 1 }, { ...raw, connections: [{ localPort: '1', remotePort: 2, pid: 3, state: '' }] },
    { ...raw, processes: [{ pid: -1, parent: 1, name: 'x', created: null, path: null }] }]) {
    assert.throws(() => parseWindowsIngressSnapshot(invalid));
  }
});

test('Windows binary and tool resolution uses fixed local install paths, never PATH, UNC or non-exe overrides', () => {
  const files = new Set([CLI, 'C:\\Users\\someone\\bin\\tailscale.exe', 'D:\\Tools\\tailscale.exe', 'D:\\Tools\\tailscale.cmd',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
  const exists = (file: string) => files.has(file);
  assert.equal(resolveWindowsTailscaleBinary({ PATH: 'C:\\Users\\someone\\bin', ProgramFiles: 'C:\\Program Files' }, exists), CLI);
  assert.equal(resolveWindowsTailscaleBinary({ ProgramFiles: '\\\\attacker\\share' }, exists), CLI);
  assert.equal(resolveWindowsTailscaleBinary({ PATH: 'C:\\Users\\someone\\bin' }, f => f !== CLI && exists(f)), null);
  assert.equal(resolveWindowsTailscaleBinary({ MICHI_TAILSCALE_BIN: 'D:\\Tools\\tailscale.exe' }, exists), 'D:\\Tools\\tailscale.exe');
  for (const override of ['tailscale.exe', '.\\tailscale.exe', '\\\\server\\share\\tailscale.exe', 'D:\\Tools\\tailscale.cmd', 'D:\\Tools\\missing.exe', 'C:\\x\\a:b.exe']) {
    assert.equal(resolveWindowsTailscaleBinary({ MICHI_TAILSCALE_BIN: override }, exists), null, override);
  }
  assert.equal(windowsTailscaledFor(CLI), DAEMON);
  assert.equal(windowsPowerShellPath({ SystemRoot: 'C:\\Windows' }, exists), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(windowsPowerShellPath({ SystemRoot: '\\\\attacker\\share' }, exists), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(windowsPowerShellPath({ SystemRoot: 'D:\\Win' }, exists), null);
  assert.equal(serviceExecutable(`"${DAEMON}" /subproc x`), DAEMON);
  assert.equal(serviceExecutable(DAEMON), 'C:\\Program');
  assert.match(windowsIngressScript(50000), /\$_\.LocalPort -eq 50000 -or \$_\.RemotePort -eq 50000/);
  assert.match(windowsIngressScript(50000), /CimCmdlets\\Get-CimInstance -ClassName Win32_Service -Filter "Name='Tailscale'"/);
  for (const port of [0, 70000, 1.5, Number.NaN, '1; Remove-Item x' as unknown as number]) assert.throws(() => windowsIngressScript(port));
});

test('the PowerShell probe runs without a shell, with System32 modules only and a decoded fixed script', async t => {
  // A stand-in executable records how it was launched. Not Windows PowerShell.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-ps-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'powershell');
  fs.writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write('\\uFEFF' + JSON.stringify({ args: process.argv.slice(2), modules: Object.entries(process.env).filter(([k]) => k.toLowerCase() === 'psmodulepath') }));\n`, { mode: 0o700 });
  const result = await powershellIngressProbe(fake, { PATH: process.env.PATH, psmodulepath: 'C:\\Users\\someone\\Modules' })(50000) as { args: string[]; modules: string[][] };
  assert.deepEqual(result.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(result.args.includes('-ExecutionPolicy'), false);
  assert.equal(Buffer.from(result.args[4], 'base64').toString('utf16le'), windowsIngressScript(50000));
  assert.deepEqual(result.modules, [['PSModulePath', path.win32.join(path.win32.dirname(fake), 'Modules')]]);
  await assert.rejects(powershellIngressProbe(path.join(dir, 'missing'))(50000), /verification failed/);
});

// ---------------------------------------------------------------------------
// Verifier batching and failure behavior
// ---------------------------------------------------------------------------

function fakeSocket(port: number, remote = '127.0.0.1', local = '127.0.0.1') {
  return { remoteAddress: remote, localAddress: local, remotePort: port, localPort: 50000, destroyed: false } as unknown as Socket;
}

test('the verifier rejects non-loopback peers without probing and fails closed on probe errors, timeouts and overload', async () => {
  let calls = 0;
  const failing = createWindowsServeVerifier({ expectedBinary: DAEMON, probe: async () => { calls++; throw new Error('Access denied'); } });
  for (const socket of [fakeSocket(50001, '100.64.0.2'), fakeSocket(50001, '::1'), fakeSocket(50001, '::ffff:127.0.0.1'), fakeSocket(50001, '127.0.0.1', '0.0.0.0')]) {
    await assert.rejects(failing.verify(socket), /loopback/);
  }
  assert.equal(calls, 0);
  await assert.rejects(failing.verify(fakeSocket(50001)), /could not verify/);
  assert.equal(calls, 1); assert.match(failing.lastError(), /could not verify/);

  const hanging = createWindowsServeVerifier({ expectedBinary: DAEMON, probe: () => new Promise(() => {}), timeoutMs: 30, maxPending: 2 });
  const timedOut = [hanging.verify(fakeSocket(50001)), hanging.verify(fakeSocket(50002))].map(p => assert.rejects(p, /could not verify/));
  await assert.rejects(hanging.verify(fakeSocket(50003)), /Too many/);
  await Promise.all(timedOut);
  // A wedged probe is bounded, so later connections still get a decision.
  await assert.rejects(hanging.verify(fakeSocket(50004)), /could not verify/);
  const queued = hanging.verify(fakeSocket(50005));
  hanging.close();
  await assert.rejects(queued, /could not verify/);
  await assert.rejects(hanging.verify(fakeSocket(50006)), /stopped/);
});

test('connections accepted together share one bounded snapshot and are decided individually', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const verifier = createWindowsServeVerifier({ expectedBinary: DAEMON, probe: async port => {
    calls++; await gate;
    return snapshotFor(port, [{ port: 50001, pid: CHILD }, { port: 50002, pid: LOCAL_APP }, { port: 50003, pid: CHILD }, { port: 50004, pid: CHILD }]);
  } });
  // The first connection starts a snapshot; later ones wait for the next snapshot.
  const first = verifier.verify(fakeSocket(50001));
  const rest = [50002, 50003, 50004].map(port => verifier.verify(fakeSocket(port)));
  release();
  const results = await Promise.allSettled([first, ...rest]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// Gateway: verified loopback TCP ingress
// ---------------------------------------------------------------------------

async function gatewayFixture(t: TestContext) {
  const app = express();
  app.use(express.json());
  const calls: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  app.use('/api', createLocalOriginGuard({ loopbackListener: true }), (req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture-backend-token') return res.status(401).end();
    next();
  });
  const transport = createStreamTransport();
  app.use('/api', transport.router);
  let subscribers = 0;
  app.all('/{*path}', (req, res) => {
    calls.push({ path: req.originalUrl, headers: req.headers });
    if (req.path.endsWith('/stream')) {
      subscribers++; res.on('close', () => subscribers--);
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('event: chunk\ndata: {"text":"中文😀"}\n\n');
    } else res.json({ ok: true });
  });
  const upstream = app.listen(0, '127.0.0.1');
  transport.attach(upstream);
  await once(upstream, 'listening');
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const state = { peerPid: CHILD, probeFails: false, probes: 0 };
  const clientPorts = new Set<number>();
  const verifier = createWindowsServeVerifier({ expectedBinary: DAEMON, probe: async gatewayPort => {
    state.probes++;
    if (state.probeFails) throw new Error('Get-NetTCPConnection is unavailable');
    return snapshotFor(gatewayPort, [...clientPorts].map(port => ({ port, pid: state.peerPid })));
  } });
  const gateway = createMobileAccessGateway({ target, token: 'fixture-backend-token', owner: 'owner@example.com',
    identityHeader: 'tailscale-user-login', probeToken: 'fixture-readiness-challenge', publicOrigin: () => origin,
    pathSecret: SECRET, verifyConnection: socket => { clientPorts.add(socket.remotePort!); return verifier.verify(socket); } });
  gateway.server.listen({ host: '127.0.0.1', port: 0 }); await once(gateway.server, 'listening');
  const port = (gateway.server.address() as AddressInfo).port;
  t.after(async () => {
    await gateway.close(); verifier.close(); transport.close(); upstream.closeAllConnections();
    await new Promise<void>(r => upstream.close(() => r()));
  });
  /** One request on its own TCP connection, so each request gets its own peer check. */
  const send = (pathname: string, headers: Record<string, string> = owner, method = 'GET') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, method, headers, agent: false }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.end();
  });
  return { gateway, port, calls, state, send, verifier, subscribers: () => subscribers };
}

test('forged local owner headers, unavailable verification and missing secrets are rejected before any forward', async t => {
  const f = await gatewayFixture(t);
  assert.equal((await f.send(`/${SECRET}/api/workspaces`)).status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '/api/workspaces');
  assert.equal(f.calls[0].headers.authorization, 'Bearer fixture-backend-token');
  assert.equal(f.calls[0].headers['tailscale-user-login'], undefined);

  // An unrelated local process stamps the owner's identity and even knows the secret.
  f.state.peerPid = LOCAL_APP;
  await assert.rejects(f.send(`/${SECRET}/api/workspaces`), /socket hang up|ECONNRESET/);
  assert.match(f.verifier.lastError(), /could not verify/);
  // Its bytes are never answered: the socket is destroyed while still paused.
  const raw = net.connect(f.port, '127.0.0.1');
  raw.on('error', () => {});
  raw.write(`GET /${SECRET}/_michi/mobile/ready HTTP/1.1\r\nHost: x\r\ntailscale-user-login: owner@example.com\r\norigin: ${origin}\r\n\r\n`);
  const received: Buffer[] = []; raw.on('data', chunk => received.push(chunk));
  await new Promise(resolve => raw.on('close', resolve));
  assert.equal(Buffer.concat(received).length, 0);

  f.state.peerPid = CHILD; f.state.probeFails = true;
  await assert.rejects(f.send(`/${SECRET}/api/workspaces`), /socket hang up|ECONNRESET/);
  f.state.probeFails = false;
  assert.equal(f.calls.length, 1);

  // Verified peer, but not Michi's own Serve handler (no or wrong secret).
  for (const pathname of ['/api/workspaces', `/${SECRET.slice(1)}x/api/workspaces`, `/${SECRET}x/api/workspaces`, `/${SECRET.toUpperCase()}/api/workspaces`]) {
    assert.equal((await f.send(pathname)).status, 404, pathname);
  }
  assert.equal(f.calls.length, 1);
});

test('verified TCP ingress keeps owner, Funnel, Origin and management gates', async t => {
  const f = await gatewayFixture(t);
  const cases: Array<[Record<string, string>, string]> = [
    [{ 'tailscale-user-login': 'someone@example.com', origin }, '/api/workspaces'],
    [{ origin }, '/api/workspaces'],
    [{ ...owner, 'tailscale-funnel-request': '?1' }, '/api/workspaces'],
    [{ ...owner, origin: 'https://evil.example' }, '/api/workspaces'],
    [owner, '/api/mobile-access/link'],
    [owner, '/_michi/mobile/session/../../api/mobile-access'],
  ];
  for (const [headers, pathname] of cases) assert.equal((await f.send(`/${SECRET}${pathname}`, headers)).status, 403, JSON.stringify([headers, pathname]));
  // Duplicate identity headers are joined by Node and never equal the owner.
  const raw = net.connect(f.port, '127.0.0.1');
  raw.on('error', () => {});
  raw.write(`GET /${SECRET}/api/workspaces HTTP/1.1\r\nHost: x\r\nConnection: close\r\ntailscale-user-login: owner@example.com\r\ntailscale-user-login: owner@example.com\r\n\r\n`);
  let text = ''; raw.setEncoding('utf8'); raw.on('data', c => { text += c; }); await once(raw, 'close');
  assert.match(text, /^HTTP\/1\.1 403/);
  assert.equal(f.calls.length, 0);
  const ready = await f.send(`/${SECRET}/_michi/mobile/ready`);
  assert.deepEqual(ready, { status: 200, body: 'fixture-readiness-challenge' });
  // The phone URL contains no path secret or token.
  assert.equal(f.gateway.mintLink().url, `${origin}/`);
});

test('SSE and multiplexed WebSocket work only on verified, secret-prefixed connections and revoke on disconnect', async t => {
  const f = await gatewayFixture(t);
  const sse = await new Promise<{ res: import('node:http').IncomingMessage; first: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: f.port, path: `/${SECRET}/api/chats/node/stream`, headers: owner, agent: false }, res => {
      res.setEncoding('utf8'); res.once('data', first => resolve({ res, first }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(sse.res.headers['content-encoding'], undefined);
  assert.match(sse.first, /中文😀/);
  assert.equal(f.subscribers(), 1);

  const ticket = async () => JSON.parse((await f.send(`/${SECRET}/api/stream-transport`, owner, 'POST')).body).token as string;
  const wsUrl = (token: string, secret = SECRET) => `ws://127.0.0.1:${f.port}/${secret}/api/stream-transport?token=${token}`;
  const token = await ticket();
  for (const [url, headers] of [[wsUrl(token, ''), owner], [wsUrl(token, 'wrong'), owner], [wsUrl(token), { origin }],
    [wsUrl(token), { ...owner, origin: 'https://evil.example' }], [wsUrl(token), { ...owner, 'tailscale-funnel-request': '?1' }]] as const) {
    const wrong = new WebSocket(url, { headers });
    await assert.rejects(once(wrong, 'open'), /40[34]|socket hang up/);
  }
  f.state.peerPid = LOCAL_APP;
  const forged = new WebSocket(wsUrl(token), { headers: owner });
  await assert.rejects(once(forged, 'open'), /socket hang up|ECONNRESET/);
  f.state.peerPid = CHILD;
  const socket = new WebSocket(wsUrl(token), { headers: owner });
  const frames: StreamTransportResponse[] = [];
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'open', id: 'stream', path: '/api/chats/node/stream', method: 'GET' }));
  await until(() => frames.some(frame => frame.type === 'data'));
  assert.equal(f.subscribers(), 2);

  // Identity loss: every verified stream closes, while the listener stays usable.
  sse.res.on('error', () => {});
  const closed = Promise.all([once(socket, 'close'), new Promise(resolve => sse.res.on('close', resolve))]);
  f.gateway.disconnect(); await closed;
  await until(() => f.subscribers() === 0);
  assert.equal(f.calls.filter(c => c.path.endsWith('/cancel')).length, 0);
  assert.equal((await f.send(`/${SECRET}/api/workspaces`)).status, 200);
});

test('a verification that completes after disconnect never hands the socket to HTTP', async t => {
  let resolveVerify!: () => void;
  const gateway = createMobileAccessGateway({ target: 'http://127.0.0.1:9', owner: 'owner@example.com', publicOrigin: () => origin,
    pathSecret: SECRET, verifyConnection: () => new Promise<void>(resolve => { resolveVerify = resolve; }) });
  gateway.server.listen({ host: '127.0.0.1', port: 0 }); await once(gateway.server, 'listening');
  t.after(() => gateway.close());
  const raw = net.connect((gateway.server.address() as AddressInfo).port, '127.0.0.1');
  raw.on('error', () => {});
  raw.write(`GET /${SECRET}/_michi/mobile/ready HTTP/1.1\r\nHost: x\r\ntailscale-user-login: owner@example.com\r\n\r\n`);
  await until(() => !!resolveVerify);
  const received: Buffer[] = []; raw.on('data', chunk => received.push(chunk));
  const closed = new Promise(resolve => raw.on('close', resolve));
  gateway.disconnect(); resolveVerify();
  await closed;
  assert.equal(Buffer.concat(received).length, 0);
  assert.throws(() => createMobileAccessGateway({ target: 'http://127.0.0.1:9', owner: 'o', publicOrigin: () => origin, verifyConnection: async () => {} }), /path secret/);
  assert.throws(() => createMobileAccessGateway({ target: 'http://127.0.0.1:9', owner: 'o', publicOrigin: () => origin, pathSecret: 'short' }), /path secret/);
});

test('verified connections still have bounded request time', async t => {
  const gateway = createMobileAccessGateway({ target: 'http://127.0.0.1:9', owner: 'owner@example.com', publicOrigin: () => origin,
    pathSecret: SECRET, verifyConnection: async () => {}, requestTimeoutMs: 200 });
  gateway.server.listen({ host: '127.0.0.1', port: 0 }); await once(gateway.server, 'listening');
  t.after(() => gateway.close());
  const raw = net.connect((gateway.server.address() as AddressInfo).port, '127.0.0.1');
  raw.on('error', () => {});
  raw.write(`GET /${SECRET}/ HTTP/1.1\r\nHost: x\r\n`);
  let text = ''; raw.setEncoding('utf8'); raw.on('data', c => { text += c; });
  const started = Date.now();
  await new Promise(resolve => raw.on('close', resolve));
  assert.match(text, /^HTTP\/1\.1 408/);
  assert.ok(Date.now() - started < 5000);
});

// ---------------------------------------------------------------------------
// Provider on simulated Windows
// ---------------------------------------------------------------------------

const hostname = 'michi.tail123.ts.net';
const node = { BackendState: 'Running', Self: { DNSName: hostname + '.', UserID: 7 }, User: { '7': { LoginName: 'owner@example.com' } } };
function child() {
  const events = new EventEmitter();
  return Object.assign(events, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null,
    kill(signal: string) { this.signalCode = signal; events.emit('exit', null, signal); return true; } });
}

async function windowsProvider(t: TestContext, options: { probe?: WindowsIngressProbe | null; powershell?: string | null } = {}) {
  const upstream = createHttpServer((req, res) => {
    if (req.url?.endsWith('/stream')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: live\n\n'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  let status: object = node;
  let config: any = {};
  const peer = { pid: CHILD };
  const clientPorts = new Set<number>();
  const children: Array<{ args: string[]; process: ReturnType<typeof child> }> = [];
  let connecting = 0;
  const probe: WindowsIngressProbe = async gatewayPort => {
    // The simulated OS table lists every client this test has connected.
    await until(() => connecting === 0, 100);
    return snapshotFor(gatewayPort, [...clientPorts].map(port => ({ port, pid: peer.pid })));
  };
  const access = new TailscaleMobileAccess({ target: () => `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, token: () => 'private-backend-token',
    platform: () => 'win32', resolveBinary: () => CLI, pollMs: 60_000, retryMs: 1,
    windowsIngressProbe: options.probe === null ? undefined : options.probe ?? probe,
    windowsPowerShell: () => options.powershell ?? null,
    probe: async (o, token) => { assert.equal(o, `https://${hostname}`); assert.match(token, /^[a-f0-9]{48}$/); },
    run: async (_binary, args) => JSON.stringify(args[0] === 'status' ? status : config),
    spawn: (_binary, args) => {
      const process = child(); children.push({ args, process });
      // Tailscale removes a foreground Serve session's config when it ends.
      process.once('exit', () => { config.Foreground = undefined; });
      return process as unknown as ChildProcess;
    },
  });
  t.after(async () => { await access.stop(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); });
  const endpoint = () => children.at(-1)!.args[2];
  const connect = () => {
    config.Foreground = { michi: { TCP: { '443': { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { '/': { Proxy: endpoint() } } } } } };
  };
  /** A local client whose port is known to the simulated OS table. */
  const open = (pathname: string, headers: Record<string, string> = owner) => new Promise<{ status: number; res: import('node:http').IncomingMessage }>((resolve, reject) => {
    const { port } = new URL(endpoint());
    connecting++;
    const socket = net.connect(Number(port), '127.0.0.1', () => { clientPorts.add(socket.localPort!); connecting--; });
    socket.on('error', () => {});
    const req = request({ createConnection: () => socket, path: pathname, headers }, res => {
      res.on('error', () => {}); resolve({ status: res.statusCode!, res });
    });
    req.on('error', reject); req.end();
  });
  return { access, children, endpoint, connect, open, peer, setNode: (value: object) => { status = value; }, config: () => config };
}

test('Windows hosts on verified loopback TCP with a per-run Serve path secret that never leaves the backend', async t => {
  const printed: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
  }
  const f = await windowsProvider(t);
  await f.access.start();
  assert.equal(f.children.length, 1);
  const [verb, https, endpoint] = f.children[0].args;
  assert.deepEqual([verb, https], ['serve', '--https=443']);
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/([a-f0-9]{48})$/.exec(endpoint);
  assert.ok(match, 'Serve targets loopback TCP with a path secret');
  const secret = match[2];
  f.connect();
  const status = await f.access.status();
  assert.equal(status.state, 'connected'); assert.equal(status.available, true);
  const link = f.access.link();
  assert.equal(link.url, `https://${hostname}/`);
  for (const value of [JSON.stringify(status), JSON.stringify(link), ...printed]) assert.equal(value.includes(secret), false);

  const ready = await f.open(`/${secret}/_michi/mobile/ready`);
  assert.equal(ready.status, 200); ready.res.resume();
  assert.equal((await f.open('/_michi/mobile/ready')).status, 404);
  f.peer.pid = LOCAL_APP;
  await assert.rejects(f.open(`/${secret}/api/workspaces`), /socket hang up|ECONNRESET/);
  f.peer.pid = CHILD;
  assert.equal((await f.open(`/${secret}/api/workspaces`)).status, 200);

  await f.access.stop();
  assert.equal(f.children[0].process.signalCode, 'SIGTERM');
  await assert.rejects(f.open(`/${secret}/api/workspaces`), /ECONNREFUSED/);
});

test('Windows account changes close verified streams; Funnel and foreign Serve routes to the ingress fail closed', async t => {
  const f = await windowsProvider(t);
  await f.access.start(); f.connect(); await f.access.status();
  const secret = new URL(f.endpoint()).pathname.slice(1);
  const stream = await f.open(`/${secret}/api/chats/node/stream`);
  assert.equal(stream.status, 200);
  stream.res.on('error', () => {});
  const closed = new Promise(resolve => stream.res.on('close', resolve));
  f.setNode({ ...node, User: { '7': { LoginName: 'another@example.com' } } });
  const changed = await f.access.status();
  assert.equal(changed.state, 'error'); assert.equal(changed.url, '');
  await closed;
  assert.equal(f.children[0].process.signalCode, 'SIGTERM');
  assert.throws(() => f.access.link());

  f.setNode(node);
  await f.access.start(); f.connect(); assert.equal((await f.access.status()).state, 'connected');
  f.config().AllowFunnel = { [`${hostname}:443`]: true };
  const funnel = await f.access.status();
  assert.equal(funnel.state, 'error'); assert.match(funnel.error, /made public/);

  delete f.config().AllowFunnel;
  await f.access.start(); f.connect(); assert.equal((await f.access.status()).state, 'connected');
  const port = new URL(f.endpoint()).port;
  f.config().TCP = { '9999': { TCPForward: `localhost:${port}` } };
  const foreign = await f.access.status();
  assert.equal(foreign.state, 'error'); assert.match(foreign.error, /Another Tailscale Serve entry/);
  assert.equal(f.children.at(-1)!.process.signalCode, 'SIGTERM');
});

test('Windows without an OS peer verifier never starts a header-trusting ingress', async t => {
  const f = await windowsProvider(t, { probe: null, powershell: null });
  const status = await f.access.status();
  assert.equal(status.available, false); assert.match(status.error, /PowerShell to verify/);
  await assert.rejects(f.access.start(), /PowerShell to verify/);
  assert.equal(f.children.length, 0);
});

test('foreign Serve routes are detected across foreground jobs, Services, mounts and loopback aliases', () => {
  const endpoint = 'http://127.0.0.1:50000/' + 'b'.repeat(48);
  const own = { TCP: { '443': { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { '/': { Proxy: endpoint } } } } };
  assert.equal(foreignIngressRoute({ Foreground: { michi: own } }, endpoint, `${hostname}:443`), false);
  assert.equal(foreignIngressRoute({ Foreground: { michi: own, other: { Web: { [`${hostname}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } } }, endpoint, `${hostname}:443`), false);
  for (const config of [
    { TCP: { '22': { TCPForward: '127.0.0.1:50000' } } },
    { TCP: { '22': { TCPForward: '[::1]:50000', TerminateTLS: hostname } } },
    { Web: { [`${hostname}:8443`]: { Handlers: { '/': { Proxy: endpoint } } } } },
    { Web: { [`${hostname}:443`]: { Handlers: { '/x': { Proxy: 'http://localhost:50000' } } } } },
    { Services: { 'svc:michi': { Web: { 'michi.tail123.ts.net:443': { Handlers: { '/': { Proxy: 'https+insecure://127.0.0.2:50000' } } } } } } },
  ]) {
    assert.equal(foreignIngressRoute({ Foreground: { michi: own }, ...config } as never, endpoint, `${hostname}:443`), true, JSON.stringify(config));
  }
  const socket = 'unix:/tmp/michi-ts-x/http.sock';
  assert.equal(foreignIngressRoute({ TCP: { '22': { TCPForward: socket } } }, socket, `${hostname}:443`), true);
  assert.equal(foreignIngressRoute({ TCP: { '22': { TCPForward: '127.0.0.1:50000' } } }, socket, `${hostname}:443`), false);
});

test('foreign-route detection covers dialable loopback spellings and treats DNS names on the ingress port as a match', () => {
  const endpoint = 'http://127.0.0.1:50000/' + 'b'.repeat(48);
  const own = { TCP: { '443': { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { '/': { Proxy: endpoint } } } } };
  const forward = (target: string) => foreignIngressRoute({ Foreground: { michi: own }, TCP: { '22': { TCPForward: target } } } as never, endpoint, `${hostname}:443`);
  const proxy = (target: string) => foreignIngressRoute({ Foreground: { michi: own }, Web: { [`${hostname}:8443`]: { Handlers: { '/': { Proxy: target } } } } } as never, endpoint, `${hostname}:443`);
  for (const target of ['[::ffff:127.0.0.1]:50000', '[::ffff:7f00:1]:50000', '[0:0:0:0:0:0:0:1]:50000', '[::]:50000', '[::ffff:0:0]:50000',
    'localhost.:50000', 'LOCALHOST:50000', 'app.localhost:50000', '127.1:50000', '2130706433:50000', '0x7f000001:50000', '0x7f.1:50000',
    '0177.0.0.1:50000', '0:50000', '127.0.0.1:050000', 'tls-terminated-tcp://127.0.0.1:50000',
    // A name can resolve to this machine; Michi does not trust resolution.
    'michi-alias.example:50000', '127.0.0.1.example:50000',
    // Unparseable targets that still name the port fail closed.
    '::1:50000', '[::1%25lo0]:50000']) {
    assert.equal(forward(target), true, target);
  }
  for (const target of ['http://[::ffff:127.0.0.1]:50000', 'https+insecure://localhost.:50000/x', 'http://2130706433:50000', 'http://0x7f.0.0.1:50000']) {
    assert.equal(proxy(target), true, target);
  }
  // Only IP literals proven not to be loopback, other ports and default ports are excluded.
  for (const target of ['192.168.1.5:50000', '[2001:db8::1]:50000', '100.64.0.1:50000', '128.0.0.1:50000', '0x80000001:50000',
    'localhost:50001', 'michi-alias.example:5000', '::1:9999']) {
    assert.equal(forward(target), false, target);
  }
  assert.equal(proxy('http://localhost'), false);
});

test('foreign-route detection matches Unix socket aliases through symlinks, hard links and relative paths', async t => {
  if (process.platform === 'win32') { t.skip('Unix sockets'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-ts-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'michi-ts-abc123');
  fs.mkdirSync(dir, { mode: 0o700 });
  const socketPath = path.join(dir, 'http.sock');
  const listener = net.createServer().listen(socketPath); await once(listener, 'listening');
  t.after(() => new Promise<void>(resolve => listener.close(() => resolve())));
  fs.symlinkSync(dir, path.join(root, 'alias'));
  fs.linkSync(socketPath, path.join(root, 'hard.sock'));
  const endpoint = `unix:${socketPath}`;
  const forward = (target: string) => foreignIngressRoute({ TCP: { '22': { TCPForward: target } } }, endpoint, `${hostname}:443`);
  for (const target of [endpoint, `unix:${path.join(root, 'alias', 'http.sock')}`, `unix:${path.join(root, 'hard.sock')}`,
    `unix:${fs.realpathSync(socketPath)}`, `unix:${dir}//./http.sock`, 'unix:tmp/michi-ts-abc123/http.sock']) {
    assert.equal(forward(target), true, target);
  }
  for (const target of [`unix:${path.join(root, 'missing.sock')}`, 'unix:tmp/other/http.sock', '127.0.0.1:50000']) {
    assert.equal(forward(target), false, target);
  }
});
