import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  electronArchiveName,
  findCachedArchive,
  isElectronReady,
  platformBinaryPath,
  prepareElectronBinary,
} from './prepare-electron-binary.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'michi-electron-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const electronDir = join(root, 'node_modules', 'electron');
  await mkdir(electronDir, { recursive: true });
  await writeFile(join(electronDir, 'package.json'), JSON.stringify({ version: '41.7.0' }));
  await writeFile(join(electronDir, 'checksums.json'), '{}');
  return { root, electronDir };
}

async function installFakeDist(destination, platform = 'darwin') {
  const binaryPath = platformBinaryPath(platform);
  await mkdir(join(destination, ...binaryPath.split('/').slice(0, -1)), { recursive: true });
  await writeFile(join(destination, binaryPath), 'fake electron');
  await writeFile(join(destination, 'version'), '41.7.0\n');
  if (platform !== 'win32') await chmod(join(destination, binaryPath), 0o755);
}

test('platform paths and archive names match Electron distributions', () => {
  assert.equal(platformBinaryPath('darwin'), 'Electron.app/Contents/MacOS/Electron');
  assert.equal(platformBinaryPath('linux'), 'electron');
  assert.equal(platformBinaryPath('win32'), 'electron.exe');
  assert.equal(electronArchiveName('41.7.0', 'darwin', 'arm64'), 'electron-v41.7.0-darwin-arm64.zip');
  assert.throws(() => platformBinaryPath('aix'), /not available/);
});

test('findCachedArchive searches Electron cache hash directories', async (t) => {
  const { root } = await fixture(t);
  const archive = join(root, 'cache', 'hash', 'electron-v41.7.0-darwin-arm64.zip');
  await mkdir(join(root, 'cache', 'hash'), { recursive: true });
  await writeFile(archive, 'zip');
  assert.equal(await findCachedArchive([join(root, 'cache')], 'electron-v41.7.0-darwin-arm64.zip'), archive);
});

test('complete installations skip extraction', async (t) => {
  const { root, electronDir } = await fixture(t);
  await installFakeDist(join(electronDir, 'dist'));
  await writeFile(join(electronDir, 'path.txt'), platformBinaryPath('darwin'));
  let extracts = 0;

  const result = await prepareElectronBinary({
    rootDir: root,
    platform: 'darwin',
    arch: 'arm64',
    extractArchive: async () => { extracts += 1; },
  });

  assert.equal(result.repaired, false);
  assert.equal(extracts, 0);
  assert.equal(await isElectronReady(electronDir, 'darwin', '41.7.0'), true);
});

test('partial installations are replaced from a cached archive', async (t) => {
  const { root, electronDir } = await fixture(t);
  const cacheRoot = join(root, 'cache');
  const archive = join(cacheRoot, 'electron-v41.7.0-darwin-arm64.zip');
  await mkdir(join(electronDir, 'dist'), { recursive: true });
  await writeFile(join(electronDir, 'dist', 'LICENSES.chromium.html'), 'partial');
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(archive, 'fake zip');

  const result = await prepareElectronBinary({
    rootDir: root,
    platform: 'darwin',
    arch: 'arm64',
    cacheRoots: [cacheRoot],
    extractArchive: async (_archivePath, destination) => installFakeDist(destination),
  });

  assert.equal(result.repaired, true);
  assert.equal(await readFile(join(electronDir, 'path.txt'), 'utf8'), platformBinaryPath('darwin'));
  assert.equal(await isElectronReady(electronDir, 'darwin', '41.7.0'), true);
  await assert.rejects(readFile(join(electronDir, 'dist', 'LICENSES.chromium.html')), /ENOENT/);
});

test('missing cache reports both lookup and download failure', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    prepareElectronBinary({
      rootDir: root,
      platform: 'darwin',
      arch: 'arm64',
      cacheRoots: [join(root, 'missing-cache')],
      downloadArchive: async () => { throw new Error('offline'); },
    }),
    /was not found.*download failed: offline/,
  );
});
