#!/usr/bin/env node

/**
 * Read-only real-runtime inventory for native Pages acceptance preparation.
 * Starts a fresh backend with disposable database/config directories, asks its
 * existing runtime status/catalog APIs what is installed and configured, then
 * removes the disposable state. This script never sends a chat turn or prints
 * credentials, environment values, workspace content, or raw provider errors.
 *
 * Run from the repository root: node scripts/pages-real-runtime-inventory.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const backendDir = path.join(root, 'backend');
const disposable = await mkdtemp(path.join(os.tmpdir(), 'michi-pages-runtime-'));
const dataDir = path.join(disposable, 'data');
const configDir = path.join(disposable, 'config');
const server = await reservePort();
let startupDiagnostics = '';
const child = spawn(process.execPath, ['--require', 'ts-node/register', 'src/server.ts'], {
  cwd: backendDir,
  env: {
    ...process.env,
    PORT: String(server.port),
    HOST: '127.0.0.1',
    MICHI_DATA_DIR: dataDir,
    MICHI_CONFIG_DIR: configDir,
    MICHI_LOG_DIR: path.join(disposable, 'logs'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  startupDiagnostics = `${startupDiagnostics}${chunk}`.slice(-8000);
});

const base = `http://127.0.0.1:${server.port}/api`;
let finished = false;
try {
  const ready = await waitForReady(base, child);
  if (!ready) {
    const detail = sanitize(startupDiagnostics).trim();
    throw new Error(`Disposable backend did not become ready${detail ? `:\n${detail}` : ''}`);
  }

  const status = await getJson(`${base}/agent/status`);
  const runtimes = [];
  for (const item of status.availableRuntimes ?? []) {
    const runtime = {
      id: item.id,
      label: item.label,
      available: Boolean(item.available),
      requiresApiKey: Boolean(item.requiresApiKey),
      ...(item.unavailableReason ? { unavailableReason: sanitize(item.unavailableReason) } : {}),
    };
    if (runtime.available) {
      try {
        // The backend stores this selection only in the disposable config
        // directory. This lets /agent/status evaluate each registered
        // runtime's existing provider settings without touching user config.
        await sendJson(`${base}/agent/options`, { runtime: item.id });
        const selectedStatus = await getJson(`${base}/agent/status`);
        runtime.hasRequiredKey = selectedStatus.hasRequiredKey === true;
        runtime.selectedProvider = selectedStatus.provider ?? null;
        runtime.configuredProviders = (selectedStatus.providers ?? []).map((provider) => ({
          id: provider.id,
          hasKey: provider.hasKey === true,
          ready: provider.ready === true,
          requiresUserKey: Boolean(provider.requiresUserKey),
        }));
        const catalog = await getJson(`${base}/agent/runtime-catalog?runtime=${encodeURIComponent(item.id)}`);
        runtime.modelCount = Array.isArray(catalog.models) ? catalog.models.length : 0;
      } catch (error) {
        runtime.catalogError = sanitize(error.message);
      }
    }
    runtimes.push(runtime);
  }

  console.log(JSON.stringify({
    result: 'inventory_only_no_model_invoked',
    activeRuntime: status.runtime,
    runtimes,
    isolation: { dataDir: '<temporary>', configDir: '<temporary>', workspaceCreated: false },
    note: 'Provider key status comes from Michi runtime APIs. Secret values are never requested or printed.',
  }, null, 2));
  finished = true;
} finally {
  child.kill('SIGTERM');
  await waitChild(child, 5000);
  await rm(disposable, { recursive: true, force: true });
}

if (!finished) process.exitCode = 1;

async function reservePort() {
  const net = await import('node:net');
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return { port };
}

async function waitForReady(apiBase, processHandle) {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    if (processHandle.exitCode !== null) return false;
    try {
      const response = await fetch(`${apiBase}/ready`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch { /* startup is still in progress */ }
    await delay(250);
  }
  return false;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function sendJson(url, value) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function sanitize(message) {
  return String(message).replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+)/g, '[redacted]').slice(0, 240);
}

function waitChild(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => processHandle.once('exit', resolve)),
    delay(timeoutMs).then(() => processHandle.kill('SIGKILL')),
  ]);
}
