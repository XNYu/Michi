import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { nodePtyPaths, rebuildNativeModules } from './rebuild-electron-natives.mjs';

async function fixture(t, { platform, arch = 'arm64', prebuild = true, partialBuild = true }) {
  const root = await mkdtemp(join(tmpdir(), 'michi-native-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = nodePtyPaths(root, platform, arch);
  if (prebuild) {
    await mkdir(dirname(paths.prebuild), { recursive: true });
    await writeFile(paths.prebuild, 'prebuilt pty');
  }
  if (partialBuild) {
    await mkdir(join(paths.buildDir, 'Release', 'obj.target'), { recursive: true });
  }
  return { root, paths };
}

const failingInstall = async () => {
  throw new Error('npm exec -- electron-builder install-app-deps exited 1');
};

test('successful rebuilds keep the compiled build output', async (t) => {
  const { root, paths } = await fixture(t, { platform: 'darwin' });
  let installs = 0;

  const result = await rebuildNativeModules({
    rootDir: root,
    platform: 'darwin',
    arch: 'arm64',
    installAppDeps: async () => { installs += 1; },
    warn: () => assert.fail('no warning expected'),
  });

  assert.deepEqual(result, { usedPrebuild: false });
  assert.equal(installs, 1);
  assert.equal(existsSync(paths.buildDir), true);
});

test('macOS falls back to the prebuild and removes the partial rebuild', async (t) => {
  const { root, paths } = await fixture(t, { platform: 'darwin' });
  const warnings = [];

  const result = await rebuildNativeModules({
    rootDir: root,
    platform: 'darwin',
    arch: 'arm64',
    installAppDeps: failingInstall,
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(result, { usedPrebuild: true });
  assert.equal(existsSync(paths.buildDir), false);
  assert.equal(existsSync(paths.prebuild), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /install-app-deps exited 1/);
  assert.match(warnings[0], /darwin-arm64/);
});

test('Windows falls back to the prebuild without touching build output', async (t) => {
  const { root, paths } = await fixture(t, { platform: 'win32', arch: 'x64' });

  const result = await rebuildNativeModules({
    rootDir: root,
    platform: 'win32',
    arch: 'x64',
    installAppDeps: failingInstall,
    warn: () => {},
  });

  assert.deepEqual(result, { usedPrebuild: true });
  assert.equal(existsSync(paths.buildDir), true);
});

test('macOS without a matching prebuild still fails the rebuild', async (t) => {
  const { root, paths } = await fixture(t, { platform: 'darwin', prebuild: false });

  await assert.rejects(
    rebuildNativeModules({
      rootDir: root,
      platform: 'darwin',
      arch: 'arm64',
      installAppDeps: failingInstall,
      warn: () => assert.fail('no warning expected'),
    }),
    /install-app-deps exited 1/,
  );
  assert.equal(existsSync(paths.buildDir), true);
});

test('platforms without a fallback rethrow even when a prebuild exists', async (t) => {
  const { root } = await fixture(t, { platform: 'linux', arch: 'x64' });

  await assert.rejects(
    rebuildNativeModules({
      rootDir: root,
      platform: 'linux',
      arch: 'x64',
      installAppDeps: failingInstall,
      warn: () => assert.fail('no warning expected'),
    }),
    /install-app-deps exited 1/,
  );
});
