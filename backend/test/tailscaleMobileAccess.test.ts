import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TailscaleMobileAccess, tailscaleActionUrl, tailscaleServePort } from '../src/services/tailscaleMobileAccess';
import { createMobileAccess, defaultMobileAccessProvider, MobileAccessManager, type MobileAccessController } from '../src/services/mobileAccessManager';
import { readMobileAccessChoice, saveMobileAccessChoice } from '../src/services/mobileAccess';

const hostname = 'michi.tail123.ts.net';
const node = { BackendState: 'Running', Self: { DNSName: hostname + '.', UserID: 7 }, User: { '7': { LoginName: 'owner@example.com' } } };
function child() {
  const events = new EventEmitter();
  return Object.assign(events, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null,
    kill(signal: string) { this.signalCode = signal; events.emit('exit', null, signal); return true; } });
}
function fixture() {
  let status: object = node;
  let config: any = {};
  let commandFailure = '';
  let probeFailure = false;
  let installed = true;
  const calls: string[][] = [];
  const children: Array<{ args: string[]; process: ReturnType<typeof child> }> = [];
  const access = new TailscaleMobileAccess({ target: () => 'http://127.0.0.1:3000', token: () => 'private-backend-token',
    resolveBinary: () => installed ? '/fixture/tailscale' : null, pollMs: 60_000, retryMs: 1,
    probe: async (origin, token) => { assert.match(origin, /^https:\/\/michi\.tail123\.ts\.net(?::\d+)?$/); assert.match(token, /^[a-f0-9]{48}$/); if (probeFailure) throw new Error('Serve cannot dial the Unix socket'); },
    run: async (_binary, args) => { calls.push(args); if (args[0] === commandFailure) throw new Error('CLI unavailable'); return JSON.stringify(args[0] === 'status' ? status : config); },
    spawn: (_binary, args) => { const process = child(); children.push({ args, process }); return process as unknown as ChildProcess; },
  });
  const connect = () => {
    const args = children.at(-1)!.args;
    const port = Number(args[1].split('=')[1]);
    config.Foreground = { michi: { TCP: { [port]: { HTTPS: true } }, Web: { [`${hostname}:${port}`]: { Handlers: { '/': { Proxy: args[2] } } } } } };
  };
  return { access, calls, children, connect, setNode: (value: object) => { status = value; },
    setConfig: (value: object) => { config = value; }, config: () => config, install: (value: boolean) => { installed = value; },
    failCommand: (value: string) => { commandFailure = value; }, failProbe: (value: boolean) => { probeFailure = value; } };
}

test('guided setup detects installation/login and only accepts official login and consent links', async t => {
  const f = fixture(); t.after(() => f.access.stop());
  f.install(false);
  assert.equal((await f.access.status()).tailscale?.state, 'not-installed');
  await assert.rejects(f.access.start(), /Install Tailscale/);
  f.install(true); f.setNode({ BackendState: 'NeedsLogin' });
  assert.equal((await f.access.status()).tailscale?.state, 'needs-login');
  await f.access.login(); await f.access.login();
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.children[0].args, ['up', '--json', '--timeout=2m']);
  f.children[0].process.stdout.write('{"AuthURL":"https://login.tailscale.com/a/');
  assert.equal((await f.access.status()).tailscale?.actionUrl, undefined);
  f.children[0].process.stdout.write('fixture"}\n');
  assert.equal((await f.access.status()).tailscale?.actionUrl, 'https://login.tailscale.com/a/fixture');
  for (const value of ['https://login.tailscale.com.evil/a/x', 'https://evil.test/a/x', 'https://login.tailscale.com/admin/dns']) assert.equal(tailscaleActionUrl(value), undefined);
});

test('Serve owns one private socket, confirms config before publishing and preserves other listeners on stop', async t => {
  const f = fixture(); t.after(() => f.access.stop());
  const existing = { TCP: { '443': { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } };
  f.setConfig(existing);
  await Promise.all([f.access.start(), f.access.start()]);
  assert.equal(f.children.length, 1);
  assert.equal((await f.access.status()).state, 'starting');
  assert.throws(() => f.access.link(), /Connect Tailscale Serve/);
  assert.deepEqual(f.children[0].args.slice(0, 2), ['serve', '--https=8443']);
  const socket = f.children[0].args[2].replace(/^unix:/, '');
  assert.equal(fs.statSync(path.dirname(socket)).mode & 0o777, 0o700);
  f.connect();
  assert.equal((await f.access.status()).state, 'connected');
  const link = f.access.link();
  assert.equal(link.url, `https://${hostname}:8443/`); assert.equal(link.reusable, true);
  await f.access.stop();
  assert.equal(f.children[0].process.signalCode, 'SIGTERM');
  assert.equal(fs.existsSync(path.dirname(socket)), false);
  assert.equal(f.config().Web[`${hostname}:443`].Handlers['/'].Proxy, 'http://127.0.0.1:9999');
  assert.equal(f.calls.some(args => args.includes('reset') || args.includes('off') || args[0] === 'down'), false);
});

test('a fresh Tailscale installation with no Serve config can start, but Windows never exposes a header-trusting TCP ingress', async t => {
  const f = fixture(); t.after(() => f.access.stop());
  f.setConfig(null as unknown as object);
  await f.access.start();
  assert.equal(f.children.length, 1);
  await f.access.stop();
  t.mock.method(os, 'platform', () => 'win32');
  assert.equal((await f.access.status()).available, false);
  await assert.rejects(f.access.start(), /private Unix socket/);
  assert.equal(f.children.length, 1);
});

test('restoring an enabled choice waits for Tailscale startup without opening an ingress or signing in automatically', async t => {
  const f = fixture(); t.after(() => f.access.stop());
  f.failCommand('status');
  assert.equal((await f.access.start()).state, 'reconnecting');
  assert.equal(f.children.length, 0);
  f.failCommand(''); f.setNode({ BackendState: 'NeedsLogin' });
  assert.equal((await f.access.status()).tailscale?.state, 'needs-login');
  assert.equal(f.children.length, 0);
  f.setNode(node);
  await f.access.status();
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].args[0], 'serve');
  f.connect();
  assert.equal((await f.access.status()).state, 'connected');
});

test('HTTPS consent remains actionable across status polls and is cleared after Serve is confirmed', async t => {
  const f = fixture(); t.after(() => f.access.stop());
  await f.access.start();
  f.children[0].process.stderr.write('Enable HTTPS: https://login.tailscale.com/f/serve?node=fixture\n');
  assert.equal((await f.access.status()).tailscale?.state, 'needs-approval');
  assert.equal((await f.access.status()).tailscale?.actionUrl, 'https://login.tailscale.com/f/serve?node=fixture');
  f.children[0].process.emit('exit', 1);
  assert.equal((await f.access.status()).tailscale?.actionUrl, 'https://login.tailscale.com/f/serve?node=fixture');
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.access.status();
  assert.equal(f.children.length, 2);
  f.connect();
  const connected = await f.access.status();
  assert.equal(connected.state, 'connected'); assert.equal(connected.tailscale?.state, 'ready');
  assert.equal(connected.tailscale?.actionUrl, undefined);
});

test('tagged, missing-owner and invalid-hostname nodes revoke a previously connected ingress', async t => {
  for (const invalid of [
    { ...node, Self: { ...node.Self, Tags: ['tag:server'] } },
    { ...node, User: {} },
    { ...node, Self: { ...node.Self, DNSName: 'unverified.example.com.' } },
  ]) {
    const f = fixture(); t.after(() => f.access.stop());
    await f.access.start(); f.connect(); await f.access.status();
    const socket = f.children[0].args[2].replace(/^unix:/, '');
    f.setNode(invalid);
    const status = await f.access.status();
    assert.equal(status.state, 'error'); assert.equal(status.url, '');
    assert.equal(status.tailscale?.state, 'error');
    assert.equal(fs.existsSync(socket), false);
    assert.equal(f.children[0].process.signalCode, 'SIGTERM');
    assert.throws(() => f.access.link());
  }
});

test('failed or malformed status commands unpublish the URL until both node and Serve can be verified again', async t => {
  const f = fixture(); t.after(() => f.access.stop());
  await f.access.start(); f.connect(); await f.access.status();
  for (const command of ['status', 'serve']) {
    f.failCommand(command);
    assert.equal((await f.access.status()).url, '');
    assert.throws(() => f.access.link());
    f.failCommand('');
    assert.equal((await f.access.status()).state, 'connected');
  }
  f.setNode(null as unknown as object);
  assert.equal((await f.access.status()).tailscale?.state, 'not-running');
  assert.equal((await f.access.status()).url, '');
});

test('an HTTPS mapping cannot publish a QR until the authenticated ingress is reachable through Serve', async t => {
  const f = fixture(); t.after(() => f.access.stop());
  await f.access.start(); f.connect(); f.failProbe(true);
  const failed = await f.access.status();
  assert.equal(failed.state, 'reconnecting'); assert.equal(failed.url, '');
  assert.match(failed.error, /could not be reached/); assert.throws(() => f.access.link());
  f.failProbe(false);
  assert.equal((await f.access.status()).state, 'connected');
  assert.equal(f.access.link().reusable, true);
});

test('losing login invalidates the URL; changing account tears down the old owner ingress', async t => {
  const f = fixture(); t.after(() => f.access.stop());
  await f.access.start(); f.connect(); await f.access.status();
  f.setNode({ BackendState: 'NeedsLogin' });
  assert.equal((await f.access.status()).url, ''); assert.throws(() => f.access.link());
  f.setNode({ ...node, User: { '7': { LoginName: 'another@example.com' } } });
  assert.equal((await f.access.status()).state, 'error');
  assert.equal(f.children[0].process.signalCode, 'SIGTERM');
  assert.throws(() => f.access.link());
});

test('Funnel on the selected listener fails closed, and stop does not disable Tailscale', async t => {
  const f = fixture(); t.after(() => f.access.stop());
  await f.access.start(); f.connect();
  f.config().AllowFunnel = { [`${hostname}:443`]: true };
  const status = await f.access.status();
  assert.equal(status.state, 'error'); assert.match(status.error, /made public/);
  assert.equal(status.url, ''); assert.equal(f.children[0].process.signalCode, 'SIGTERM');
});

test('a failed Serve process can reconnect, and a later stop ignores stale child output', async t => {
  const f = fixture(); t.after(() => f.access.stop());
  await f.access.start();
  f.children[0].process.emit('exit', 1);
  const status = await f.access.status();
  assert.equal(status.state, 'reconnecting'); assert.ok(status.retryAt);
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.access.status(); assert.equal(f.children.length, 2);
  f.connect(); assert.equal((await f.access.status()).state, 'connected');
  await f.access.stop();
  f.children[0].process.stdout.write('https://login.tailscale.com/f/serve?old=1\n');
  assert.equal((await f.access.status()).state, 'stopped');
});

test('selects a free port and restores only an explicit Tailscale preference', t => {
  assert.equal(tailscaleServePort({ TCP: { '443': {} }, Foreground: { one: { TCP: { '8443': {} } } } }), 9443);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-ts-choice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mobile-access.json');
  assert.equal(defaultMobileAccessProvider(), 'tailscale');
  assert.equal(readMobileAccessChoice(file), false);
  fs.writeFileSync(file, JSON.stringify({ enabled: true }));
  assert.equal(readMobileAccessChoice(file), false);
  fs.writeFileSync(file, JSON.stringify({ enabled: true, provider: 'other' }));
  assert.equal(readMobileAccessChoice(file), false);
  saveMobileAccessChoice(file, true, 'tailscale');
  assert.equal(readMobileAccessChoice(file), true);
  saveMobileAccessChoice(file, false);
  assert.equal(readMobileAccessChoice(file), false);
});

test('the public factory exposes only Tailscale and rejects unsupported providers', async t => {
  const access = createMobileAccess({ target: () => 'http://127.0.0.1:3000', token: () => null, resolveBinary: () => null });
  t.after(() => access.stop());
  const status = await access.status();
  assert.equal(status.provider, 'tailscale'); assert.deepEqual(status.providers, ['tailscale']);
  assert.equal(status.tailscale?.state, 'not-installed');
  await assert.rejects(access.select('other' as never), /unavailable in this Michi build/);
});

test('concurrent manager actions retain start/stop ordering', async () => {
  const calls: string[] = [];
  const status = { state: 'stopped' as const, url: '', error: '', available: true };
  const service: MobileAccessController = { status: () => status,
    start: async () => { calls.push('start'); return status; },
    stop: async () => { calls.push('stop'); return status; },
    link: () => ({ url: 'https://michi.tail123.ts.net/', expiresAt: 0 }),
  };
  const manager = new MobileAccessManager({ tailscale: service }, 'tailscale');
  await Promise.all([manager.start(), manager.stop(), manager.start()]);
  assert.deepEqual(calls, ['start', 'stop', 'start']);
});
