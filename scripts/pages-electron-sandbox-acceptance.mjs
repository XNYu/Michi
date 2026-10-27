#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js');
const script = path.join(root, 'scripts', 'pages-electron-sandbox-acceptance.cjs');
const child = spawn(process.execPath, [electronCli, script], {
  cwd: root,
  env: { ...process.env, NODE_OPTIONS: '' },
  stdio: 'inherit',
  windowsHide: true,
});
const timeout = setTimeout(() => {
  console.error('pages-electron-sandbox-acceptance: Electron process timed out; stopping only the smoke process');
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
}, 60_000);
child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  process.exitCode = code ?? (signal ? 1 : 0);
});
child.on('error', (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});
