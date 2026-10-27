/**
 * macOS "background service" mode: the backend runs as a per-user launchd
 * LaunchAgent, so it keeps running (and scheduled jobs keep firing) after the
 * desktop app quits. Electron attaches to it instead of forking a child.
 *
 * This module has no `electron` import so it can be tested with plain Node.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const SERVICE_LABEL = 'com.michi.backend';

/** Environment variables the service inherits from the app when set. */
const PASSTHROUGH_ENV = [
  'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
  'MICHI_DATA_DIR', 'MICHI_CONFIG_DIR', 'MICHI_DEFAULT_RUNTIME', 'MICHI_ENABLED_RUNTIMES',
  'MICHI_CUSTOM_AGENTS', 'KIRO_CLI_BIN',
];

export interface ServiceState {
  enabled: boolean;
  port: number;
}

export interface ServicePaths {
  stateFile: string;
  plistFile: string;
}

export interface ServiceLaunchSpec {
  label: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
}

export function servicePaths(home: string = os.homedir(), label: string = SERVICE_LABEL): ServicePaths {
  return {
    stateFile: path.join(home, '.michi', 'service.json'),
    plistFile: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
  };
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;
}

export function readServiceState(file: string): ServiceState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (typeof raw.enabled !== 'boolean' || !validPort(raw.port)) return null;
    return { enabled: raw.enabled, port: raw.port };
  } catch {
    return null;
  }
}

function writeFileAtomic(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { mode });
  fs.renameSync(temp, file);
}

export function writeServiceState(file: string, state: ServiceState): void {
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

/** Same derivation as the backend's /api/health serverId (remoteAccess.ts). */
export function expectedServerId(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const dataDir = env.MICHI_DATA_DIR || path.join(home, '.michi');
  return createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
}

/** Identifies the installed app build, so an update restarts the service. */
export function serviceBuildStamp(appPath: string, version: string): string {
  try {
    return `${version}-${Math.round(fs.statSync(appPath).mtimeMs)}`;
  } catch {
    return version;
  }
}

/** `.../michi.app` for an executable inside the bundle, else null. */
export function appBundlePath(execPath: string): string | null {
  const marker = '.app/Contents/';
  const index = execPath.indexOf(marker);
  return index < 0 ? null : execPath.slice(0, index + '.app'.length);
}

export function buildServiceLaunchSpec(input: {
  /** Electron's helper binary; runs the bundle as Node with ELECTRON_RUN_AS_NODE. */
  nodeExecPath: string;
  entry: string;
  port: number;
  logDir: string;
  bundlePath: string | null;
  build: string;
  baseEnv: NodeJS.ProcessEnv;
  defaultRuntime?: string | null;
  label?: string;
}): ServiceLaunchSpec {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(input.port),
    MICHI_LOG_DIR: input.logDir,
    // The service is always the loopback desktop backend, never a remote one.
    MICHI_BIND_HOST: '127.0.0.1',
    MICHI_REMOTE_ACCESS: '0',
    MICHI_SERVICE_MODE: '1',
    MICHI_SERVICE_BUILD: input.build,
    PATH: input.baseEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: input.baseEnv.HOME || os.homedir(),
  };
  for (const key of PASSTHROUGH_ENV) {
    const value = input.baseEnv[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  if (input.bundlePath) env.MICHI_APP_BUNDLE = input.bundlePath;
  if (input.defaultRuntime && !env.MICHI_DEFAULT_RUNTIME) env.MICHI_DEFAULT_RUNTIME = input.defaultRuntime;
  return {
    label: input.label ?? SERVICE_LABEL,
    program: input.nodeExecPath,
    args: [input.entry],
    env,
    // Matches a Finder launch ("/"), which skips the boot-time warm session.
    workingDirectory: '/',
    stdoutPath: path.join(input.logDir, 'service.out.log'),
    stderrPath: path.join(input.logDir, 'service.err.log'),
  };
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderPlist(spec: ServiceLaunchSpec): string {
  const strings = (values: string[]) => values.map((value) => `    <string>${xml(value)}</string>`).join('\n');
  const env = Object.entries(spec.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings([spec.program, ...spec.args])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.stderrPath)}</string>
</dict>
</plist>
`;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type LaunchctlRunner = (args: string[]) => Promise<CommandResult>;

export const runLaunchctl: LaunchctlRunner = (args) => new Promise((resolve) => {
  execFile('/bin/launchctl', args, { timeout: 30_000 }, (error, stdout, stderr) => {
    // A non-zero exit carries the numeric exit code; spawn failures carry a string.
    const raw = (error as { code?: unknown } | null)?.code;
    const code = !error ? 0 : typeof raw === 'number' ? raw : 1;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

function domain(uid: number): string {
  return `gui/${uid}`;
}

export async function isServiceLoaded(run: LaunchctlRunner, uid: number, label: string = SERVICE_LABEL): Promise<boolean> {
  return (await run(['print', `${domain(uid)}/${label}`])).code === 0;
}

/** Stop the service (waiting for it to exit) and optionally remove its plist. */
export async function stopService(options: {
  run: LaunchctlRunner;
  uid: number;
  plistFile: string;
  label?: string;
  removePlist?: boolean;
  delay?: (ms: number) => Promise<void>;
  unloadTimeoutMs?: number;
}): Promise<void> {
  const label = options.label ?? SERVICE_LABEL;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (await isServiceLoaded(options.run, options.uid, label)) {
    await options.run(['bootout', `${domain(options.uid)}/${label}`]);
    // bootout can return while the backend is still shutting down; wait until
    // launchd has really unloaded it so a following bootstrap succeeds.
    const deadline = Date.now() + (options.unloadTimeoutMs ?? 20_000);
    while (Date.now() < deadline && await isServiceLoaded(options.run, options.uid, label)) {
      await delay(250);
    }
  }
  if (options.removePlist) {
    try { fs.unlinkSync(options.plistFile); } catch { /* already gone */ }
  }
}

/** Write the plist and (re)load it; RunAtLoad starts the backend. */
export async function installAndStartService(options: {
  spec: ServiceLaunchSpec;
  run: LaunchctlRunner;
  uid: number;
  plistFile: string;
  delay?: (ms: number) => Promise<void>;
}): Promise<void> {
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  fs.mkdirSync(path.dirname(options.spec.stdoutPath), { recursive: true });
  await stopService({ run: options.run, uid: options.uid, plistFile: options.plistFile, label: options.spec.label, delay });
  writeFileAtomic(options.plistFile, renderPlist(options.spec), 0o644);
  let result = await options.run(['bootstrap', domain(options.uid), options.plistFile]);
  if (result.code !== 0) {
    // A bootout can still be settling; one retry covers that race.
    await delay(1000);
    result = await options.run(['bootstrap', domain(options.uid), options.plistFile]);
  }
  if (result.code !== 0) {
    throw new Error(`launchctl bootstrap failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  await options.run(['enable', `${domain(options.uid)}/${options.spec.label}`]);
}
