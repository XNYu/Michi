import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Socket } from 'node:net';

/**
 * Windows Tailscale Serve cannot proxy to a Unix socket ("unix socket serve
 * target is not supported on Windows" in tailscale/ipn/serve.go), so Michi's
 * phone ingress must use loopback TCP. A loopback port is reachable by every
 * local process, and tailscaled itself can dial loopback on behalf of tailnet
 * peers (netstack forwards traffic for the node's Tailscale IP to 127.0.0.1).
 * Before any byte is parsed, each connection must therefore be proven by the OS
 * to come from the running Tailscale Windows service, and every request must
 * carry the per-run path segment that only Michi's own Serve handler prepends.
 * Lookup failures always reject the connection.
 */

const win = path.win32;
type Env = Record<string, string | undefined>;
type IsFile = (file: string) => boolean;

export const WINDOWS_TAILSCALE_SERVICE = 'Tailscale';
const DAEMON = 'tailscaled.exe';

function isFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** An absolute local drive path. UNC, device, relative and malformed values are refused. */
function localDrivePath(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text || !/^[A-Za-z]:\\/.test(text) || /[\0<>"|?*]/.test(text.slice(2)) || text.slice(2).includes(':')) return null;
  return win.normalize(text);
}

function sameFile(a: string | null | undefined, b: string): boolean {
  return !!a && win.normalize(a).toLowerCase() === win.normalize(b).toLowerCase();
}

/**
 * Only the official per-machine install location (or an explicit absolute .exe
 * override). PATH is never searched, so a planted tailscale.exe in a writable or
 * current directory cannot be selected. Callers run the result without a shell.
 */
export function resolveWindowsTailscaleBinary(env: Env = process.env, exists: IsFile = isFile): string | null {
  const override = env.MICHI_TAILSCALE_BIN?.trim();
  if (override) {
    const file = localDrivePath(override);
    return file && /\.exe$/i.test(file) && exists(file) ? file : null;
  }
  const roots = [env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files'].map(localDrivePath).filter((root): root is string => !!root);
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root.toLowerCase())) continue;
    seen.add(root.toLowerCase());
    const candidate = win.join(root, 'Tailscale', 'tailscale.exe');
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The service binary installed beside the CLI by the official MSI. */
export function windowsTailscaledFor(cli: string): string {
  return win.join(win.dirname(cli), DAEMON);
}

/** Inbox Windows PowerShell from System32 only; never resolved through PATH. */
export function windowsPowerShellPath(env: Env = process.env, exists: IsFile = isFile): string | null {
  const root = localDrivePath(env.SystemRoot) ?? localDrivePath(env.windir) ?? 'C:\\Windows';
  const file = win.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return exists(file) ? file : null;
}

/**
 * Service image from SCM's binary path. A quoted path is taken verbatim; an
 * unquoted path may not contain spaces (that ambiguity is itself a Windows
 * service misconfiguration), so it fails the binary comparison.
 */
export function serviceExecutable(pathName: string): string | null {
  const match = /^\s*"([^"]+)"(?:\s.*)?$/.exec(pathName) ?? /^\s*([^\s"]+)(?:\s.*)?$/.exec(pathName);
  return match ? match[1] : null;
}

export interface WindowsServiceFacts { state: string; pid: number; path: string; account: string; type: string }
export interface WindowsTcpRow { localPort: number; remotePort: number; pid: number; state: string }
export interface WindowsProcessFacts { pid: number; parent: number; name: string; created: string | null; path: string | null }
export interface WindowsIngressSnapshot {
  /** UTC time just before the TCP table was read. */
  start: string;
  /** SCM facts read before and after the TCP/process snapshots. */
  service: WindowsServiceFacts | null;
  serviceAfter: WindowsServiceFacts | null;
  connections: WindowsTcpRow[];
  processes: WindowsProcessFacts[];
}

function list(value: unknown): unknown[] {
  // Windows PowerShell may serialize a one-element collection as an object.
  return value == null ? [] : Array.isArray(value) ? value : [value];
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Windows connection snapshot');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Windows connection snapshot');
  return value;
}
function text(value: unknown, optional = false): string {
  if (typeof value === 'string') return value;
  if (optional && value == null) return '';
  throw new Error('Invalid Windows connection snapshot');
}
function service(value: unknown): WindowsServiceFacts | null {
  if (value == null) return null;
  const s = record(value);
  return { state: text(s.state), pid: integer(s.pid), path: text(s.path, true), account: text(s.account, true), type: text(s.type, true) };
}

export function parseWindowsIngressSnapshot(value: unknown): WindowsIngressSnapshot {
  const raw = record(value);
  return {
    start: text(raw.start),
    service: service(raw.service),
    serviceAfter: service(raw.serviceAfter),
    connections: list(raw.connections).map(row => {
      const r = record(row);
      return { localPort: integer(r.localPort), remotePort: integer(r.remotePort), pid: integer(r.pid), state: text(r.state, true) };
    }),
    processes: list(raw.processes).map(row => {
      const p = record(row);
      const created = p.created == null ? null : text(p.created);
      return { pid: integer(p.pid), parent: integer(p.parent), name: text(p.name, true), created, path: text(p.path, true) || null };
    }),
  };
}

export interface WindowsConnectionContext {
  gatewayPort: number;
  clientPort: number;
  /** PID of this backend process, which owns the accepted socket. */
  ownPid: number;
  /** Epoch milliseconds when this process accepted the connection. */
  acceptedAt: number;
  expectedBinary: string;
}

const UNVERIFIED = 'Michi could not verify that this connection came from the Tailscale Windows service.';
const established = (state: string) => /^(?:established|5)$/i.test(state.trim());

/**
 * Pure decision over one OS snapshot. Returns null only when the connection's
 * client endpoint is owned by the running Tailscale service's process (or its
 * babysat tailscaled child) and that ownership cannot be explained by PID reuse.
 */
export function windowsConnectionRefusal(snapshot: WindowsIngressSnapshot, context: WindowsConnectionContext): string | null {
  const { service: before, serviceAfter: after } = snapshot;
  if (!before || !after) return 'The Tailscale Windows service is not running or is not visible to this user.';
  for (const facts of [before, after]) {
    if (facts.state !== 'Running' || facts.pid <= 0) return 'The Tailscale Windows service is not running.';
    if (!/^own process$/i.test(facts.type.trim()) || !/^localsystem$/i.test(facts.account.trim())) return 'The Tailscale Windows service has an unexpected configuration.';
    if (!sameFile(serviceExecutable(facts.path), context.expectedBinary)) return 'The Tailscale Windows service does not match the installed Tailscale CLI.';
  }
  if (before.pid !== after.pid) return 'The Tailscale Windows service restarted during verification.';

  // Both endpoints of this exact loopback tuple must be present and unique.
  const client = snapshot.connections.filter(row => row.localPort === context.clientPort && row.remotePort === context.gatewayPort);
  const server = snapshot.connections.filter(row => row.localPort === context.gatewayPort && row.remotePort === context.clientPort);
  if (client.length !== 1 || server.length !== 1 || !established(client[0].state) || !established(server[0].state)) return UNVERIFIED;
  if (server[0].pid !== context.ownPid || client[0].pid <= 0) return UNVERIFIED;

  const byPid = new Map<number, WindowsProcessFacts>();
  for (const process of snapshot.processes) {
    if (byPid.has(process.pid)) return UNVERIFIED;
    byPid.set(process.pid, process);
  }
  const daemon = byPid.get(before.pid);
  const peer = byPid.get(client[0].pid);
  if (!daemon || !peer) return UNVERIFIED;
  const started = Date.parse(snapshot.start);
  const daemonCreated = Date.parse(daemon.created ?? '');
  const peerCreated = Date.parse(peer.created ?? '');
  // Creation times are required to exclude reuse of either PID.
  if (![started, daemonCreated, peerCreated].every(Number.isFinite)) return UNVERIFIED;
  for (const facts of [daemon, peer]) {
    if (facts.name.toLowerCase() !== DAEMON) return UNVERIFIED;
    if (facts.path && !sameFile(facts.path, context.expectedBinary)) return UNVERIFIED;
  }
  // tailscaled's Windows service babysits a "/subproc" child that runs the
  // backend and dials Serve targets. A reused parent PID cannot predate its child.
  if (peer.pid !== daemon.pid && (peer.parent !== daemon.pid || peerCreated < daemonCreated)) return UNVERIFIED;
  // The owning process existed before Michi accepted this connection. A process
  // that reused the PID afterwards cannot inherit an earlier connection.
  if (!(peerCreated < context.acceptedAt && daemonCreated < context.acceptedAt && context.acceptedAt <= started + 1000)) return UNVERIFIED;
  return null;
}

/** One bounded read of SCM, the loopback TCP table and the involved processes. */
export function windowsIngressScript(gatewayPort: number): string {
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) throw new Error('Invalid ingress port');
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'function Get-MichiTailscaleService {',
    `  $s = CimCmdlets\\Get-CimInstance -ClassName Win32_Service -Filter "Name='${WINDOWS_TAILSCALE_SERVICE}'"`,
    '  if ($null -eq $s) { return $null }',
    '  [ordered]@{ state = [string]$s.State; pid = [int64]$s.ProcessId; path = [string]$s.PathName; account = [string]$s.StartName; type = [string]$s.ServiceType }',
    '}',
    "$start = [DateTime]::UtcNow.ToString('o')",
    '$service = Get-MichiTailscaleService',
    `$rows = @(NetTCPIP\\Get-NetTCPConnection -LocalAddress 127.0.0.1 -RemoteAddress 127.0.0.1 -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${gatewayPort} -or $_.RemotePort -eq ${gatewayPort} } | ForEach-Object { [ordered]@{ localPort = [int]$_.LocalPort; remotePort = [int]$_.RemotePort; pid = [int64]$_.OwningProcess; state = [string]$_.State } })`,
    '$ids = @(@($rows | ForEach-Object { $_.pid }) + @(if ($service) { $service.pid }) | Where-Object { $_ -gt 0 } | Sort-Object -Unique)',
    '$processes = @()',
    'if ($ids.Count -gt 0) {',
    "  $filter = ($ids | ForEach-Object { 'ProcessId=' + [int64]$_ }) -join ' OR '",
    '  $processes = @(CimCmdlets\\Get-CimInstance -ClassName Win32_Process -Filter $filter | ForEach-Object {',
    '    [ordered]@{ pid = [int64]$_.ProcessId; parent = [int64]$_.ParentProcessId; name = [string]$_.Name;',
    "      created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); path = [string]$_.ExecutablePath } })",
    '}',
    '$after = Get-MichiTailscaleService',
    '[ordered]@{ start = $start; service = $service; serviceAfter = $after; connections = $rows; processes = $processes } | ConvertTo-Json -Compress -Depth 5',
  ].join('\n');
}

export type WindowsIngressProbe = (gatewayPort: number) => Promise<unknown>;

/** Runs the fixed script with System32 modules only. No shell, elevation or system change. */
export function powershellIngressProbe(powershell: string, env: Env = process.env, timeoutMs = 10_000): WindowsIngressProbe {
  return gatewayPort => new Promise((resolve, reject) => {
    const encoded = Buffer.from(windowsIngressScript(gatewayPort), 'utf16le').toString('base64');
    // Module-qualified cmdlets load only from the inbox System32 module path.
    const childEnv: Env = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
    childEnv.PSModulePath = win.join(win.dirname(powershell), 'Modules');
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, env: childEnv,
    }, (error, stdout) => {
      if (error) { reject(new Error('Windows connection verification failed')); return; }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch { reject(new Error('Windows connection verification failed')); }
    });
  });
}

interface Pending {
  socket: Socket;
  context: WindowsConnectionContext;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Coalesces connections accepted before one snapshot starts into that snapshot,
 * runs at most one probe at a time and rejects on timeout, overload or error.
 */
export function createWindowsServeVerifier(options: {
  expectedBinary: string;
  probe: WindowsIngressProbe;
  ownPid?: number;
  now?: () => number;
  timeoutMs?: number;
  maxPending?: number;
}) {
  const now = options.now ?? Date.now;
  const ownPid = options.ownPid ?? process.pid;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxPending = options.maxPending ?? 64;
  let queue: Pending[] = [];
  let running = false;
  let closed = false;
  let pending = 0;
  let lastError = '';
  const settle = (entry: Pending, error?: Error) => {
    if (entry.settled) return;
    entry.settled = true; pending--; clearTimeout(entry.timer);
    if (error) entry.reject(error); else entry.resolve();
  };
  // A wedged probe must not hold later connections forever.
  const bounded = (port: number) => new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Windows connection verification timed out')), timeoutMs);
    timer.unref?.();
    options.probe(port).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const fail = (entry: Pending, reason: string) => { lastError = reason; settle(entry, new Error(reason)); };
  const round = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const batch = queue.filter(entry => !entry.settled); queue = [];
        if (!batch.length) continue;
        let snapshot: WindowsIngressSnapshot;
        try { snapshot = parseWindowsIngressSnapshot(await bounded(batch[0].context.gatewayPort)); }
        catch { for (const entry of batch) fail(entry, UNVERIFIED); continue; }
        for (const entry of batch) {
          const reason = closed || entry.socket.destroyed ? UNVERIFIED : windowsConnectionRefusal(snapshot, entry.context);
          if (reason) fail(entry, reason); else { lastError = ''; settle(entry); }
        }
      }
    } finally { running = false; }
  };
  return {
    verify(socket: Socket): Promise<void> {
      return new Promise((resolve, reject) => {
        const acceptedAt = now();
        const remote = socket.remoteAddress, local = socket.localAddress;
        const clientPort = socket.remotePort, gatewayPort = socket.localPort;
        if (closed) { reject(new Error('Phone access is stopped.')); return; }
        if (remote !== '127.0.0.1' || local !== '127.0.0.1' || !clientPort || !gatewayPort) {
          reject(new Error('Mobile access accepts only loopback connections from Tailscale.')); return;
        }
        if (pending >= maxPending) { reject(new Error('Too many unverified phone connections.')); return; }
        pending++;
        const entry: Pending = { socket, settled: false, resolve, reject,
          context: { gatewayPort, clientPort, ownPid, acceptedAt, expectedBinary: options.expectedBinary },
          timer: setTimeout(() => fail(entry, UNVERIFIED), timeoutMs) };
        entry.timer.unref?.();
        queue.push(entry);
        void round();
      });
    },
    lastError: () => lastError,
    close() {
      closed = true;
      for (const entry of queue) settle(entry, new Error(UNVERIFIED));
      queue = [];
    },
  };
}
