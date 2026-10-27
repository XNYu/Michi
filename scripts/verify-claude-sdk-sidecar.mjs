import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { createPackage } from '@electron/asar';

// Run after backend:build. Validate the production CJS loader with no checkout
// node_modules nearby; optionally validate the same loader inside Electron ASAR.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'michi-sdk-sidecar-'));
try {
  const contents = path.join(temporary, 'contents');
  await mkdir(contents);
  await cp(path.join(repo, 'backend/dist/claude-sdk'), path.join(contents, 'claude-sdk'), { recursive: true });
  const entry = path.join(contents, 'probe.cjs');
  await build({
    stdin: { resolveDir: repo, loader: 'ts', contents: `
      import { loadClaudeSdk } from 'michi-runtime/internal/adapters/claude/claudeSdkTransport';
      loadClaudeSdk().then(sdk => {
        for (const name of ['query', 'forkSession', 'getSessionMessages']) {
          if (typeof sdk[name] !== 'function') throw new Error('Missing SDK export: ' + name);
        }
        console.log(JSON.stringify({ok:true, asar:__dirname.includes('.asar')}));
      }).catch(error => { console.error(error.message); process.exitCode = 1; });
    ` },
    outfile: entry, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    external: ['node:*', '@anthropic-ai/claude-agent-sdk'],
  });
  const cases = [{ name: 'node', executable: process.execPath, entry }];
  if (process.env.MICHI_SDK_VERIFY_ELECTRON) {
    const archive = path.join(temporary, 'probe.asar');
    await createPackage(contents, archive);
    cases.push({ name: 'electron-asar', executable: process.env.MICHI_SDK_VERIFY_ELECTRON,
      entry: path.join(archive, 'probe.cjs') });
  }
  for (const item of cases) {
    const result = JSON.parse(execFileSync(item.executable, [item.entry], {
      cwd: temporary, env: { ...process.env, NODE_PATH: '', ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', timeout: 30_000,
    }));
    assert.equal(result.ok, true);
    if (item.name === 'electron-asar') assert.equal(result.asar, true);
    console.log(`${item.name}: production SDK sidecar loaded outside the checkout`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
