import { constants as fsConstants } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export function platformBinaryPath(platform) {
  switch (platform) {
    case 'darwin':
    case 'mas':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

export function electronArchiveName(version, platform, arch) {
  return `electron-v${version}-${platform}-${arch}.zip`;
}

export function defaultElectronCacheRoots(platform, env = process.env, home = homedir()) {
  const configured = env.ELECTRON_CACHE || env.electron_config_cache;
  if (configured) return [resolve(configured)];

  switch (platform) {
    case 'darwin':
    case 'mas':
      return [join(home, 'Library', 'Caches', 'electron')];
    case 'win32':
      return env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'electron', 'Cache')] : [];
    default:
      return [join(env.XDG_CACHE_HOME || join(home, '.cache'), 'electron')];
  }
}

async function canAccess(path, mode = fsConstants.F_OK) {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

export async function isElectronReady(electronDir, platform, version) {
  const binaryPath = platformBinaryPath(platform);
  const expectedAccess = platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;

  try {
    const [installedPath, installedVersion] = await Promise.all([
      readFile(join(electronDir, 'path.txt'), 'utf8'),
      readFile(join(electronDir, 'dist', 'version'), 'utf8'),
    ]);
    return installedPath === binaryPath
      && installedVersion.trim().replace(/^v/, '') === version
      && await canAccess(join(electronDir, 'dist', binaryPath), expectedAccess);
  } catch {
    return false;
  }
}

async function findFileRecursively(root, targetName) {
  if (basename(root) === targetName && await canAccess(root)) return root;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === targetName) return path;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = await findFileRecursively(join(root, entry.name), targetName);
    if (nested) return nested;
  }
  return undefined;
}

export async function findCachedArchive(cacheRoots, archiveName) {
  for (const root of cacheRoots) {
    const direct = join(root, archiveName);
    if (await canAccess(direct)) return direct;

    const nested = await findFileRecursively(root, archiveName);
    if (nested) return nested;
  }
  return undefined;
}

async function downloadElectronArchive({ electronDir, version, platform, arch, cacheRoot }) {
  const electronGet = await import('@electron/get');
  const downloadArtifact = electronGet.downloadArtifact || electronGet.default?.downloadArtifact;
  if (!downloadArtifact) throw new Error('@electron/get does not export downloadArtifact');

  const checksums = JSON.parse(await readFile(join(electronDir, 'checksums.json'), 'utf8'));
  return downloadArtifact({
    version,
    artifactName: 'electron',
    platform,
    arch,
    cacheRoot,
    checksums,
  });
}

async function extractElectronArchive(archivePath, destination, platform) {
  await mkdir(destination, { recursive: true });
  switch (platform) {
    case 'darwin':
    case 'mas':
      await execFile('/usr/bin/ditto', ['-x', '-k', archivePath, destination]);
      return;
    case 'win32':
      await execFile('tar.exe', ['-xf', archivePath, '-C', destination]);
      return;
    default:
      await execFile('unzip', ['-q', archivePath, '-d', destination]);
  }
}

export async function prepareElectronBinary(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const electronDir = resolve(options.electronDir || join(rootDir, 'node_modules', 'electron'));
  const platform = options.platform || process.env.npm_config_platform || process.platform;
  const arch = options.arch || process.env.npm_config_arch || process.arch;
  const packageJson = JSON.parse(await readFile(join(electronDir, 'package.json'), 'utf8'));
  const version = options.version || packageJson.version;
  const binaryPath = platformBinaryPath(platform);

  if (await isElectronReady(electronDir, platform, version)) {
    options.log?.(`[electron] ready: ${join(electronDir, 'dist', binaryPath)}`);
    return { repaired: false, electronDir, version, binaryPath };
  }

  options.log?.(`[electron] repairing incomplete Electron ${version} installation`);
  const cacheRoots = options.cacheRoots || defaultElectronCacheRoots(platform);
  const archiveName = electronArchiveName(version, platform, arch);
  let archivePath = await findCachedArchive(cacheRoots, archiveName);

  if (!archivePath) {
    options.log?.(`[electron] ${archiveName} not found in cache; downloading`);
    const download = options.downloadArchive || downloadElectronArchive;
    try {
      archivePath = await download({
        electronDir,
        version,
        platform,
        arch,
        cacheRoot: cacheRoots[0],
      });
    } catch (error) {
      throw new Error(
        `Unable to prepare Electron ${version}: ${archiveName} was not found in ${cacheRoots.join(', ') || 'the configured cache'} and download failed: ${error.message}`,
        { cause: error },
      );
    }
  }

  // Keep the staging directory beside dist so the final rename stays atomic
  // even when the system temp directory is mounted on another filesystem.
  const temporaryRoot = await mkdtemp(join(options.tempRoot || electronDir, '.electron-repair-'));
  const temporaryDist = join(temporaryRoot, 'dist');
  const extractArchive = options.extractArchive || extractElectronArchive;

  try {
    await extractArchive(archivePath, temporaryDist, platform);
    const extractedBinary = join(temporaryDist, binaryPath);
    if (!await canAccess(extractedBinary)) {
      throw new Error(`Electron archive is missing ${binaryPath}: ${archivePath}`);
    }
    if (platform !== 'win32') await chmod(extractedBinary, 0o755);

    const distPath = join(electronDir, 'dist');
    const previousDist = join(electronDir, `.dist.previous-${process.pid}`);
    await rm(previousDist, { recursive: true, force: true });
    if (await canAccess(distPath)) await rename(distPath, previousDist);
    try {
      await rename(temporaryDist, distPath);
    } catch (error) {
      if (await canAccess(previousDist)) await rename(previousDist, distPath);
      throw error;
    }
    await rm(previousDist, { recursive: true, force: true });
    await writeFile(join(electronDir, 'path.txt'), binaryPath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  if (!await isElectronReady(electronDir, platform, version)) {
    throw new Error(`Electron ${version} repair completed but the executable is still unavailable`);
  }

  options.log?.(`[electron] extracted ${archivePath}`);
  options.log?.(`[electron] ready: ${join(electronDir, 'dist', binaryPath)}`);
  return { repaired: true, archivePath, electronDir, version, binaryPath };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    await prepareElectronBinary({ log: console.log });
  } catch (error) {
    console.error(`[electron] ${error.message}`);
    process.exitCode = 1;
  }
}
