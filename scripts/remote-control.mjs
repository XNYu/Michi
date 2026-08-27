#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REMOTE_SERVICE_NAME = 'michi-remote.service';
export const MIN_NODE_VERSION = [22, 19, 0];

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'backend', 'dist', 'server.js');
const HEALTH_TIMEOUT_MS = 20_000;

function usage() {
  return `Michi remote backend control

Usage:
  npm run remote:launch [-- --service] [options]
  npm run remote:status
  npm run remote:stop
  npm run remote:restart [-- --service] [options]
  npm run remote:service:remove

Options:
  --service             Register/start a systemd user service
  --no-setup            Skip npm install + backend build
  --public              Bind 0.0.0.0 instead of 127.0.0.1
  --bind-host HOST      Explicit bind host
  --port PORT           Backend port (default: 3000)
  --data-dir PATH       Michi data directory (default: ~/.michi)
  --token TOKEN         Explicit token (prefer MICHI_REMOTE_TOKEN to avoid shell history)
  --help                 Show this help
`;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('--') ? args.shift() : 'launch';
  const allowedActions = new Set(['launch', 'status', 'stop', 'restart', 'remove-service']);
  if (!allowedActions.has(action)) throw new Error(`unknown action: ${action}`);

  const options = {
    action,
    service: false,
    setup: true,
    public: false,
    bindHost: undefined,
    port: undefined,
    dataDir: undefined,
    token: undefined,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--service') options.service = true;
    else if (arg === '--no-setup') options.setup = false;
    else if (arg === '--public') options.public = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--bind-host') options.bindHost = takeValue(args, index++, arg);
    else if (arg.startsWith('--bind-host=')) options.bindHost = arg.slice('--bind-host='.length);
    else if (arg === '--port') options.port = takeValue(args, index++, arg);
    else if (arg.startsWith('--port=')) options.port = arg.slice('--port='.length);
    else if (arg === '--data-dir') options.dataDir = takeValue(args, index++, arg);
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
    else if (arg === '--token') options.token = takeValue(args, index++, arg);
    else if (arg.startsWith('--token=')) options.token = arg.slice('--token='.length);
    else throw new Error(`unknown option: ${arg}`);
  }

  if (options.public && options.bindHost) {
    throw new Error('--public and --bind-host cannot be used together');
  }
  return options;
}

function expandHome(input, homeDir) {
  if (input === '~') return homeDir;
  if (input.startsWith('~/')) return path.join(homeDir, input.slice(2));
  return input;
}

function validatePort(raw) {
  const port = Number(raw ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return port;
}

function validateBindHost(host) {
  if (!host || host.length > 255 || /[\s/]/.test(host)) {
    throw new Error(`invalid bind host: ${host}`);
  }
  return host;
}

function validateToken(token) {
  if (typeof token !== 'string' || token.trim().length < 16) {
    throw new Error('MICHI_REMOTE_TOKEN must be at least 16 characters');
  }
  if (/[\r\n\0]/.test(token)) throw new Error('MICHI_REMOTE_TOKEN contains an invalid character');
  return token.trim();
}

export function parseEnvironmentFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    }
    values[key] = value;
  }
  return values;
}

function readExistingEnvironment(envFile) {
  if (!existsSync(envFile)) return {};
  try {
    return parseEnvironmentFile(readFileSync(envFile, 'utf8'));
  } catch {
    return {};
  }
}

export function resolveRemoteConfig(
  options,
  env = process.env,
  homeDir = os.homedir(),
  createToken = () => randomBytes(32).toString('base64url'),
) {
  const rawDataDir = expandHome(
    options.dataDir ?? env.MICHI_DATA_DIR ?? path.join(homeDir, '.michi'),
    homeDir,
  );
  if (/[\r\n\0]/.test(rawDataDir)) throw new Error('data directory contains an invalid character');
  const dataDir = path.resolve(rawDataDir);
  const envFile = path.join(dataDir, 'remote.env');
  const existing = readExistingEnvironment(envFile);
  const token = validateToken(
    options.token
      ?? env.MICHI_REMOTE_TOKEN
      ?? existing.MICHI_REMOTE_TOKEN
      ?? createToken(),
  );
  const port = validatePort(options.port ?? env.PORT ?? existing.PORT ?? 3000);
  const bindHost = validateBindHost(
    options.public
      ? '0.0.0.0'
      : options.bindHost
        ?? env.MICHI_BIND_HOST
        ?? existing.MICHI_BIND_HOST
        ?? '127.0.0.1',
  );

  return {
    repoRoot: REPO_ROOT,
    serverPath: SERVER_PATH,
    dataDir,
    envFile,
    pidFile: path.join(dataDir, 'remote.pid'),
    logFile: path.join(dataDir, 'remote.log'),
    token,
    port,
    bindHost,
    pathEnv: env.PATH ?? '',
  };
}

function quoteEnvironmentValue(value) {
  return JSON.stringify(String(value));
}

export function renderEnvironmentFile(config) {
  const rows = [
    'MICHI_REMOTE_ACCESS="1"',
    `MICHI_REMOTE_TOKEN=${quoteEnvironmentValue(config.token)}`,
    `MICHI_BIND_HOST=${quoteEnvironmentValue(config.bindHost)}`,
    `MICHI_DATA_DIR=${quoteEnvironmentValue(config.dataDir)}`,
    `PORT=${quoteEnvironmentValue(config.port)}`,
    'NODE_ENV="production"',
    'MICHI_REQUIRE_AUTH=""',
    'MICHI_CLOUD="0"',
  ];
  if (config.pathEnv) rows.push(`PATH=${quoteEnvironmentValue(config.pathEnv)}`);
  return `${rows.join('\n')}\n`;
}

function writeSecureFile(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, filePath);
  chmodSync(filePath, 0o600);
}

function systemdQuote(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')}"`;
}

export function renderSystemdUnit(config, nodePath = process.execPath) {
  return `[Unit]
Description=Michi remote backend
After=network.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(config.repoRoot)}
EnvironmentFile=${systemdQuote(config.envFile)}
ExecStart=${systemdQuote(nodePath)} --experimental-sqlite ${systemdQuote(config.serverPath)}
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=default.target
`;
}

export function compareVersions(actual, required = MIN_NODE_VERSION) {
  const parts = String(actual).replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < required.length; index += 1) {
    if ((parts[index] ?? 0) > required[index]) return 1;
    if ((parts[index] ?? 0) < required[index]) return -1;
  }
  return 0;
}

function assertSupportedNode() {
  if (compareVersions(process.versions.node) < 0) {
    throw new Error(`Node.js ${MIN_NODE_VERSION.join('.')} or newer is required (current: ${process.version})`);
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function runSetup() {
  runChecked('npm', ['run', 'remote:setup'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (!existsSync(SERVER_PATH)) throw new Error(`remote build did not produce ${SERVER_PATH}`);
}

function serviceUnitPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'systemd', 'user', REMOTE_SERVICE_NAME);
}

function hasSystemdUnit(homeDir = os.homedir()) {
  return existsSync(serviceUnitPath(homeDir));
}

function ensureSystemdUserAvailable() {
  const result = spawnSync('systemctl', ['--user', 'show-environment'], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      'systemd user services are unavailable. Run without --service for detached background mode.',
    );
  }
}

function isServiceActive() {
  const result = spawnSync('systemctl', ['--user', 'is-active', '--quiet', REMOTE_SERVICE_NAME], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  return result.status === 0;
}

function tryEnableLinger() {
  const user = process.env.USER;
  if (!user) return false;
  const current = spawnSync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 5_000,
  });
  if (current.status === 0 && current.stdout.trim() === 'yes') return true;
  const enabled = spawnSync('loginctl', ['enable-linger', user], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  return enabled.status === 0;
}

function readPidRecord(pidFile) {
  if (!existsSync(pidFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf8'));
    if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function pidBelongsToMichi(record, config) {
  if (!record || record.serverPath !== config.serverPath) return false;
  const procCmdline = `/proc/${record.pid}/cmdline`;
  if (!existsSync(procCmdline)) return true;
  try {
    return readFileSync(procCmdline, 'utf8').includes(config.serverPath);
  } catch {
    return false;
  }
}

function activeBackgroundRecord(config) {
  const record = readPidRecord(config.pidFile);
  if (
    !record
    || !processIsAlive(record.pid)
    || !pidBelongsToMichi(record, config)
  ) {
    if (existsSync(config.pidFile)) rmSync(config.pidFile, { force: true });
    return null;
  }
  return record;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeHealth(config) {
  return new Promise((resolve) => {
    const request = http.request({
      host: healthHostForBind(config.bindHost),
      port: config.port,
      path: '/api/health',
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}` },
      timeout: 1_000,
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode === 200));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function waitForHealth(config, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(config)) return;
    await delay(250);
  }
  throw new Error(`Michi did not become healthy on ${healthHostForBind(config.bindHost)}:${config.port} within ${timeoutMs}ms`);
}

function serverEnvironment(config) {
  return {
    ...process.env,
    MICHI_REMOTE_ACCESS: '1',
    MICHI_REMOTE_TOKEN: config.token,
    MICHI_BIND_HOST: config.bindHost,
    MICHI_DATA_DIR: config.dataDir,
    PORT: String(config.port),
    NODE_ENV: 'production',
    MICHI_REQUIRE_AUTH: '',
    MICHI_CLOUD: '0',
  };
}

export function healthHostForBind(bindHost) {
  if (bindHost === '0.0.0.0') return '127.0.0.1';
  if (bindHost === '::' || bindHost === '[::]') return '::1';
  return bindHost;
}

function configFingerprint(config) {
  return createHash('sha256')
    .update(JSON.stringify({
      serverPath: config.serverPath,
      dataDir: config.dataDir,
      port: config.port,
      bindHost: config.bindHost,
      token: config.token,
    }))
    .digest('hex');
}

async function startDetached(config) {
  const existing = activeBackgroundRecord(config);
  if (existing) {
    if (existing.configFingerprint === configFingerprint(config) && await probeHealth(config)) {
      return existing;
    }
    await stopDetached(config);
  }

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const logFd = openSync(config.logFile, 'a', 0o600);
  chmodSync(config.logFile, 0o600);
  let child;
  try {
    child = spawn(process.execPath, ['--experimental-sqlite', config.serverPath], {
      cwd: config.repoRoot,
      env: serverEnvironment(config),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  if (!child.pid) throw new Error('failed to start Michi background process');
  const record = {
    pid: child.pid,
    serverPath: config.serverPath,
    configFingerprint: configFingerprint(config),
    startedAt: Date.now(),
  };
  writeSecureFile(config.pidFile, `${JSON.stringify(record)}\n`);
  child.unref();
  try {
    await waitForHealth(config);
  } catch (error) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
    rmSync(config.pidFile, { force: true });
    throw new Error(`${error.message}. See ${config.logFile}`);
  }
  return record;
}

async function stopDetached(config) {
  const record = activeBackgroundRecord(config);
  if (!record) return false;
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && processIsAlive(record.pid)) await delay(100);
  if (processIsAlive(record.pid)) {
    try { process.kill(-record.pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  rmSync(config.pidFile, { force: true });
  return true;
}

async function installAndStartService(config) {
  await stopDetached(config);
  writeSecureFile(config.envFile, renderEnvironmentFile(config));
  const unitPath = serviceUnitPath();
  mkdirSync(path.dirname(unitPath), { recursive: true, mode: 0o700 });
  writeFileSync(unitPath, renderSystemdUnit(config), { encoding: 'utf8', mode: 0o644 });
  chmodSync(unitPath, 0o644);
  runChecked('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  runChecked('systemctl', ['--user', 'enable', REMOTE_SERVICE_NAME], { stdio: 'inherit' });
  runChecked('systemctl', ['--user', 'restart', REMOTE_SERVICE_NAME], { stdio: 'inherit' });
  await waitForHealth(config);
  return { linger: tryEnableLinger() };
}

function removeService() {
  const unitPath = serviceUnitPath();
  if (!existsSync(unitPath)) return false;
  if (isServiceActive()) {
    runChecked('systemctl', ['--user', 'disable', '--now', REMOTE_SERVICE_NAME], { stdio: 'inherit' });
  } else {
    spawnSync('systemctl', ['--user', 'disable', REMOTE_SERVICE_NAME], { stdio: 'ignore' });
  }
  rmSync(unitPath, { force: true });
  runChecked('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  return true;
}

function printConnection(config, mode, extra = {}) {
  console.log('');
  console.log('Michi remote backend is running.');
  console.log(`Mode: ${mode}`);
  console.log(`Bind: ${config.bindHost}:${config.port}`);
  console.log(`Data: ${config.dataDir}`);
  if (extra.pid) console.log(`PID: ${extra.pid}`);
  if (mode === 'background') console.log(`Log: ${config.logFile}`);
  if (mode === 'systemd user service') {
    console.log(`Logs: journalctl --user -u ${REMOTE_SERVICE_NAME} -f`);
    if (extra.linger === false) {
      console.log(`Warning: enable persistence after logout with: loginctl enable-linger ${process.env.USER ?? '$USER'}`);
    }
  }
  if (config.bindHost === '0.0.0.0') {
    console.log('Warning: the backend is network-visible; use a firewall/private network/HTTPS proxy.');
  }
  console.log('');
  console.log('Copy this token into Michi Settings -> Connections:');
  console.log(`MICHI_REMOTE_TOKEN=${config.token}`);
  console.log('');
}

async function launch(options) {
  assertSupportedNode();
  const config = resolveRemoteConfig(options);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  writeSecureFile(config.envFile, renderEnvironmentFile(config));
  const useService = options.service || hasSystemdUnit();
  if (useService) ensureSystemdUserAvailable();
  if (options.setup) runSetup();

  if (useService) {
    const result = await installAndStartService(config);
    printConnection(config, 'systemd user service', result);
    return;
  }

  if (isServiceActive()) {
    printConnection(config, 'systemd user service', { linger: undefined });
    return;
  }
  const record = await startDetached(config);
  printConnection(config, 'background', { pid: record.pid });
}

async function stop(options) {
  const config = resolveRemoteConfig(options);
  let stopped = false;
  if (hasSystemdUnit() && isServiceActive()) {
    runChecked('systemctl', ['--user', 'stop', REMOTE_SERVICE_NAME], { stdio: 'inherit' });
    stopped = true;
  }
  stopped = (await stopDetached(config)) || stopped;
  console.log(stopped ? 'Michi remote backend stopped.' : 'Michi remote backend is not running.');
}

function status(options) {
  const config = resolveRemoteConfig(options);
  if (hasSystemdUnit() && isServiceActive()) {
    console.log(`running: systemd user service (${REMOTE_SERVICE_NAME})`);
    console.log(`config: ${config.envFile}`);
    return;
  }
  const record = activeBackgroundRecord(config);
  if (record) {
    console.log(`running: background pid ${record.pid}`);
    console.log(`log: ${config.logFile}`);
    return;
  }
  console.log('stopped');
  process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.action === 'launch') return launch(options);
  if (options.action === 'stop') return stop(options);
  if (options.action === 'status') return status(options);
  if (options.action === 'remove-service') {
    console.log(removeService() ? 'Michi systemd user service removed.' : 'Michi systemd user service is not installed.');
    return;
  }
  if (options.action === 'restart') {
    await stop(options);
    return launch(options);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`remote control failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
