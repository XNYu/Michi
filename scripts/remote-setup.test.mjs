import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const backendPackage = JSON.parse(await readFile(new URL('../backend/package.json', import.meta.url), 'utf8'));

test('remote setup installs only backend and shared workspaces', () => {
  const command = rootPackage.scripts?.['remote:setup'];
  assert.equal(typeof command, 'string');
  assert.match(command, /npm install/);
  assert.match(command, /--workspace backend/);
  assert.match(command, /--workspace shared/);
  assert.match(command, /--include-workspace-root=false/);
  assert.match(command, /npm run backend:build/);
});

test('Electron-only node-pty is not a backend dependency', () => {
  assert.equal(rootPackage.dependencies?.['node-pty'], '^1.1.0');
  assert.equal(backendPackage.dependencies?.['node-pty'], undefined);
  assert.equal(backendPackage.devDependencies?.['node-pty'], undefined);
});

test('one-command remote launch is exposed without adding a remote-only dependency', () => {
  assert.equal(rootPackage.scripts?.['remote:launch'], 'node scripts/remote-control.mjs launch');
  assert.equal(rootPackage.scripts?.['remote:restart'], 'node scripts/remote-control.mjs restart');
  assert.equal(rootPackage.scripts?.['remote:stop'], 'node scripts/remote-control.mjs stop');
});
