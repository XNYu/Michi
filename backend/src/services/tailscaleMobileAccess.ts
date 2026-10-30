import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { get } from 'node:https';
import fs from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MobileAccessStatus, TailscaleSetup } from 'michi-shared';
import { createMobileAccessGateway } from './mobileAccessGateway';

interface NodeStatus {
  BackendState?: string;
  AuthURL?: string;
  Version?: string;
  Self?: { DNSName?: string; UserID?: number | string; Tags?: string[] };
  User?: Record<string, { LoginName?: string }>;
}
interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
}
interface Options {
  target: () => string;
  token: () => string | null;
  unavailableReason?: () => string | null;
  resolveBinary?: () => string | null;
  run?: (binary: string, args: string[]) => Promise<string>;
  spawn?: (binary: string, args: string[]) => ChildProcess;
  pollMs?: number;
  retryMs?: number;
  probe?: (origin: string, expectedToken: string) => Promise<void>;
}

export function resolveTailscaleBinary(): string | null {
  const override = process.env.MICHI_TAILSCALE_BIN?.trim();
  const candidates = override ? [override] : [
    ...((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'tailscale'))),
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale',
    '/usr/bin/tailscale', '/usr/local/sbin/tailscale',
  ];
  return candidates.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  }) ?? null;
}

/** Login/consent links only. Never open an arbitrary URL from subprocess output. */
export function tailscaleActionUrl(output: string): string | undefined {
  for (const match of output.matchAll(/https:\/\/login\.tailscale\.com\/[^\s"<>\\]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.hostname === 'login.tailscale.com' && !url.username && !url.password && /^\/(?:a|f)\//.test(url.pathname)) return url.href;
    } catch { /* incomplete output */ }
  }
  return undefined;
}

function configurations(config: ServeConfig): ServeConfig[] {
  return [config, ...Object.values(config.Foreground ?? {}).flatMap(configurations)];
}

function parseServeConfig(output: string): ServeConfig {
  const value: unknown = JSON.parse(output);
  // A fresh tailscaled returns JSON null before its first Serve configuration.
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Tailscale returned an invalid Serve configuration.');
  return value as ServeConfig;
}

/** Never steal an existing Serve or Funnel listener, including foreground jobs. */
export function tailscaleServePort(config: ServeConfig): number {
  const used = new Set(configurations(config).flatMap(c => [
    ...Object.keys(c.TCP ?? {}),
    ...Object.keys(c.Web ?? {}).map(key => key.slice(key.lastIndexOf(':') + 1)),
    ...Object.keys(c.AllowFunnel ?? {}).map(key => key.slice(key.lastIndexOf(':') + 1)),
  ]).map(Number));
  for (const port of [443, 8443, 9443, ...Array.from({ length: 20 }, (_, i) => 10443 + i)]) if (!used.has(port)) return port;
  throw new Error('No free HTTPS listener for Michi. Stop an unused Tailscale Serve service, then retry.');
}

function command(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(binary, args, {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/** Use the actual tailnet HTTPS path, including TLS and the provider's identity
 * header. A configured listener alone cannot prove that Serve can dial us. */
function probeServe(origin: string, expectedToken: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = get(`${origin}/_michi/mobile/ready`, { headers: { origin }, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 256) request.destroy(new Error('Unexpected Tailscale Serve response'));
      });
      response.on('error', reject);
      response.on('end', () => response.statusCode === 200 && body === expectedToken
        ? resolve() : reject(new Error('Tailscale Serve did not reach the authenticated Michi ingress')));
    });
    const timer = setTimeout(() => request.destroy(new Error('Tailscale Serve connection timed out')), 5000);
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
  });
}

/** A foreground Serve session owns only its own ephemeral configuration.
 * The proxy trusts Serve identity headers only over a private Unix socket;
 * the desktop API and other users' Serve/Funnel listeners are never exposed. */
export class TailscaleMobileAccess {
  private current: MobileAccessStatus = { state: 'stopped', url: '', error: '', available: false };
  private setup: TailscaleSetup = { state: 'not-installed' };
  private gateway?: ReturnType<typeof createMobileAccessGateway>;
  private directory?: string;
  private child?: ChildProcess;
  private loginChild?: ChildProcess;
  private timer?: ReturnType<typeof setInterval>;
  private enabled = false;
  private endpoint = '';
  private ingressOrigin = '';
  private probeToken = '';
  private hostname = '';
  private account = '';
  private port = 443;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshing?: Promise<MobileAccessStatus>;
  private failures = 0;
  private retryAt = 0;
  private connectedAt = 0;
  private serveStartedAt = 0;

  constructor(private readonly options: Options) {}

  private binary() { return (this.options.resolveBinary ?? resolveTailscaleBinary)(); }
  private run(args: string[]) {
    const binary = this.binary();
    if (!binary) throw new Error('Install Tailscale on this machine first.');
    return (this.options.run ?? command)(binary, args);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private snapshot(): MobileAccessStatus {
    const reason = this.options.unavailableReason?.() || (os.platform() === 'win32'
      ? 'Phone hosting currently requires macOS or Linux with a private Unix socket.' : '');
    return { ...this.current, available: !reason && !!this.binary(),
      error: reason || this.current.error, tailscale: { ...this.setup, canOpenApp: os.platform() === 'darwin' } };
  }

  status(): Promise<MobileAccessStatus> {
    if (!this.refreshing) {
      this.refreshing = this.serial(() => this.refresh()).finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  private suspendIngress() {
    this.ingressOrigin = '';
    this.current = { ...this.current, state: this.enabled ? 'reconnecting' : this.current.state, url: '' };
    this.connectedAt = 0;
    this.gateway?.disconnect();
  }

  private async refresh(): Promise<MobileAccessStatus> {
    if (!this.binary()) {
      this.setup = { state: 'not-installed', message: 'Install Tailscale on the machine running Michi.' };
      this.suspendIngress();
      return this.snapshot();
    }
    let node: NodeStatus;
    try {
      node = JSON.parse(await this.run(['status', '--json', '--peers=false'])) as NodeStatus;
      if (!node || typeof node !== 'object' || typeof node.BackendState !== 'string') throw new Error('Invalid Tailscale status');
    }
    catch {
      this.setup = { state: 'not-running', message: 'Open Tailscale on this machine and allow its VPN permissions. If it cannot start, update or reinstall Tailscale, then retry.' };
      this.suspendIngress();
      return this.snapshot();
    }
    if (node.BackendState !== 'Running') {
      this.setup = { state: node.BackendState === 'NeedsMachineAuth' ? 'needs-approval' : 'needs-login',
        actionUrl: tailscaleActionUrl(node.AuthURL ?? '') || this.setup.actionUrl,
        message: node.BackendState === 'NeedsMachineAuth' ? 'Approve this machine in your Tailscale admin console.' : 'Connect this machine to Tailscale. Use the same account on your phone.' };
      this.suspendIngress();
      return this.snapshot();
    }
    const login = this.loginChild; this.loginChild = undefined;
    if (login) await this.stopChild(login);
    const hostname = node.Self?.DNSName?.replace(/\.$/, '').toLowerCase() ?? '';
    const account = node.User?.[String(node.Self?.UserID)]?.LoginName;
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(hostname) || !account || node.Self?.Tags?.length) {
      this.setup = { state: 'error', message: 'Use a personal Tailscale account on this machine and enable MagicDNS. Tagged servers are not supported for owner-only phone access.' };
      this.suspendIngress();
      this.enabled = false;
      this.current = { state: 'error', url: '', error: this.setup.message!, available: true };
      await this.cleanupServe();
      return this.snapshot();
    }
    // A new login must never inherit the old owner's listener.
    if (this.gateway && (hostname !== this.hostname || account !== this.account)) {
      this.suspendIngress();
      this.enabled = false;
      this.current = { state: 'error', url: '', error: 'The Tailscale account changed. Enable phone access again for the new account.', available: true };
      this.setup = { state: 'ready', account };
      await this.cleanupServe();
      return this.snapshot();
    }
    this.hostname = hostname; this.account = account;
    const pendingApproval = this.setup.state === 'needs-approval' ? this.setup : undefined;
    this.setup = { state: 'ready', account };
    // A restored enabled choice may arrive before the Tailscale app starts.
    // Keep monitoring setup and create the private ingress once it is ready.
    if (this.enabled && !this.gateway) {
      try { await this.beginServe(); } catch { return this.snapshot(); }
    }
    if (this.enabled && this.gateway) {
      try {
        const config = parseServeConfig(await this.run(['serve', 'status', '--json']));
        const hostPort = `${hostname}:${this.port}`;
        const own = configurations(config).find(c => c.TCP?.[String(this.port)]?.HTTPS === true && c.Web?.[hostPort]?.Handlers?.['/']?.Proxy === this.endpoint);
        if (configurations(config).some(c => c.AllowFunnel?.[hostPort])) {
          this.suspendIngress(); this.enabled = false;
          this.current = { state: 'error', url: '', error: 'This listener was made public with Funnel. Michi stopped phone access. Use private Tailscale Serve.', available: true };
          await this.cleanupServe();
        } else if (own && this.child) {
          const origin = `https://${hostname}${this.port === 443 ? '' : `:${this.port}`}`;
          this.ingressOrigin = origin;
          if (this.current.state !== 'connected' || this.current.url !== origin) {
            try { await (this.options.probe ?? probeServe)(origin, this.probeToken); }
            catch {
              this.suspendIngress();
              this.current = { ...this.current, state: 'reconnecting', error: 'Michi could not be reached through Tailscale HTTPS. Check this machine’s Tailscale connection, DNS and socket permissions.' };
              return this.snapshot();
            }
            // The Serve child may exit while HTTPS is being checked.
            if (!this.child) return this.snapshot();
          }
          if (!this.connectedAt) this.connectedAt = Date.now();
          if (Date.now() - this.connectedAt >= 120_000) this.failures = 0;
          this.retryAt = 0;
          this.setup = { state: 'ready', account };
          this.current = { state: 'connected', url: origin, error: '', available: true };
        } else {
          if (pendingApproval) this.setup = pendingApproval;
          this.suspendIngress();
          this.current = { ...this.current, state: this.child ? 'starting' : 'reconnecting' };
          if (this.child && !pendingApproval && Date.now() - this.serveStartedAt > 90_000) await this.stopChild(this.child);
          if (!this.child && Date.now() >= this.retryAt) {
            // A service may have claimed the port while Michi was offline.
            // The CLI also refuses conflicts; never override or reset it.
            if (configurations(config).some(c => c.TCP?.[String(this.port)] || c.Web?.[hostPort] || c.AllowFunnel?.[hostPort])) {
              await this.cleanupServe(); this.enabled = false;
              this.current = { state: 'error', url: '', error: 'Another Tailscale service is using this HTTPS port. Enable phone access again to choose a free port.', available: true };
            } else this.launchServe();
          }
        }
      } catch {
        if (pendingApproval) this.setup = pendingApproval;
        this.suspendIngress();
        this.current = { ...this.current, state: 'reconnecting', url: '', error: 'Could not confirm Tailscale Serve. Check Tailscale on this machine.' };
      }
    }
    return this.snapshot();
  }

  start(): Promise<MobileAccessStatus> {
    return this.serial(async () => {
      if (this.enabled) return this.refresh();
      const status = await this.refresh();
      if (!status.available) throw new Error(status.error || this.setup.message || 'Install Tailscale first.');
      if (this.setup.state === 'error') return status;
      this.enabled = true;
      if (this.setup.state === 'ready') await this.beginServe();
      else this.current = { state: 'reconnecting', url: '', error: '', available: true };
      this.timer = setInterval(() => { void this.status().catch(() => {}); }, this.options.pollMs ?? 3000);
      this.timer.unref();
      return this.snapshot();
    });
  }

  private async beginServe() {
    try {
      const config = parseServeConfig(await this.run(['serve', 'status', '--json']));
      this.port = tailscaleServePort(config);
      this.failures = 0; this.retryAt = 0; this.connectedAt = 0;
      this.current = { state: 'starting', url: '', error: '', available: true };
      this.probeToken = randomBytes(24).toString('hex');
      this.gateway = createMobileAccessGateway({ target: this.options.target(), token: this.options.token(),
        owner: this.account, identityHeader: 'tailscale-user-login', probeToken: this.probeToken,
        publicOrigin: () => this.enabled ? this.ingressOrigin : '' });
      this.directory = await mkdtemp(path.join(os.tmpdir(), 'michi-ts-'));
      await chmod(this.directory, 0o700);
      const socket = path.join(this.directory, 'http.sock');
      this.gateway.server.listen(socket);
      await once(this.gateway.server, 'listening');
      this.endpoint = `unix:${socket}`;
      this.launchServe();
    } catch (error) {
      this.enabled = false;
      await this.cleanupServe();
      this.current = { state: 'error', url: '', error: (error as Error).message, available: true };
      throw error;
    }
  }

  private launchServe() {
    const binary = this.binary();
    if (!binary || !this.enabled || this.child) return;
    let child: ChildProcess;
    try { child = this.spawn(binary, ['serve', `--https=${this.port}`, this.endpoint]); }
    catch { this.failedServe(); return; }
    this.child = child;
    this.serveStartedAt = Date.now();
    this.watchOutput(child, true);
    const ended = () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failedServe();
    };
    child.once('error', ended); child.once('exit', ended);
  }

  private failedServe() {
    this.suspendIngress();
    const delay = this.options.retryMs ?? Math.min(300_000, 30_000 * 2 ** Math.min(this.failures++, 4));
    this.retryAt = Date.now() + delay;
    this.current = { ...this.current, state: 'reconnecting', url: '', retryAt: this.retryAt,
      error: 'Tailscale Serve stopped. Check permissions and update Tailscale to the latest version; Michi will retry.' };
  }

  private spawn(binary: string, args: string[]) {
    return this.options.spawn?.(binary, args) ?? spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  }

  private watchOutput(child: ChildProcess, serve: boolean) {
    const output = { stdout: '', stderr: '' };
    const read = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if ((serve ? this.child : this.loginChild) !== child) return;
      let buffer = (output[stream] + String(chunk)).slice(-8192);
      let index: number;
      // Do not publish a truncated login token when output splits mid-URL.
      while ((index = buffer.indexOf('\n')) >= 0) {
        const actionUrl = tailscaleActionUrl(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (actionUrl) this.setup = { ...this.setup, state: serve ? 'needs-approval' : 'needs-login', actionUrl,
          message: serve ? 'Allow HTTPS in Tailscale to finish connecting. This shares Michi privately with your devices.' : 'Finish signing in to Tailscale in your browser, then return here.' };
      }
      output[stream] = buffer;
    };
    child.stdout?.on('data', chunk => read('stdout', chunk)); child.stderr?.on('data', chunk => read('stderr', chunk));
  }

  login(): Promise<MobileAccessStatus> {
    return this.serial(async () => {
      await this.refresh();
      if (this.setup.state === 'ready' || this.loginChild) return this.snapshot();
      const binary = this.binary();
      if (!binary) throw new Error('Install Tailscale first.');
      if (this.setup.state !== 'needs-login') return this.snapshot();
      // No reset/force-reauth or network preference flags. Existing VPN,
      // exit-node and DNS preferences remain owned by Tailscale/the user.
      const child = this.spawn(binary, ['up', '--json', '--timeout=2m']);
      this.loginChild = child; this.watchOutput(child, false);
      const ended = () => { if (this.loginChild === child) this.loginChild = undefined; };
      child.once('error', ended); child.once('exit', ended);
      return this.snapshot();
    });
  }

  async openApp(): Promise<MobileAccessStatus> {
    if (os.platform() !== 'darwin' || !this.binary()) throw new Error('Open Tailscale on the machine running Michi.');
    await command('/usr/bin/open', ['-a', 'Tailscale']);
    return this.status();
  }

  link() {
    if (this.current.state !== 'connected' || !this.gateway) throw new Error('Connect Tailscale Serve before connecting your phone.');
    return this.gateway.mintLink();
  }

  stop(): Promise<MobileAccessStatus> {
    return this.serial(async () => {
      this.enabled = false;
      await this.cleanupServe();
      const login = this.loginChild; this.loginChild = undefined;
      if (login) await this.stopChild(login);
      this.current = { state: 'stopped', url: '', error: '', available: !!this.binary() };
      if (this.setup.state === 'needs-approval' && this.setup.actionUrl) this.setup = { state: 'ready', account: this.account };
      return this.snapshot();
    });
  }

  private async stopChild(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  private async cleanupServe() {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.gateway?.disconnect();
    const child = this.child; this.child = undefined;
    if (child) await this.stopChild(child);
    await this.gateway?.close(); this.gateway = undefined;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = undefined; this.endpoint = ''; this.ingressOrigin = ''; this.probeToken = '';
  }
}
