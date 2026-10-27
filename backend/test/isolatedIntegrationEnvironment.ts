/** Import FIRST: application modules capture HOME/config paths when loaded. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const callerHome = os.homedir();
const protectedDirectories = [
  path.join(callerHome, '.michi'),
  process.env.MICHI_CONFIG_DIR,
  process.env.MICHI_DATA_DIR,
].filter((directory): directory is string => !!directory).map((directory) => path.resolve(directory));

export const isolatedIntegrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-test-integration-'));
export const isolatedIntegrationHome = path.join(isolatedIntegrationRoot, 'home');
export const isolatedIntegrationConfigDir = path.join(isolatedIntegrationRoot, 'config');
export const isolatedIntegrationDataDir = path.join(isolatedIntegrationRoot, 'data');
for (const directory of [isolatedIntegrationHome, isolatedIntegrationConfigDir, isolatedIntegrationDataDir]) {
  fs.mkdirSync(directory, { recursive: true });
}
process.env.HOME = isolatedIntegrationHome;
process.env.USERPROFILE = isolatedIntegrationHome;
process.env.MICHI_CONFIG_DIR = isolatedIntegrationConfigDir;
process.env.MICHI_DATA_DIR = isolatedIntegrationDataDir;

// Fail closed if an imported module retains a caller's profile/data path. Guard
// atomic writes too: mocking only writeFileSync(config.json) misses tmp + rename.
function assertDisposable(target: unknown): void {
  if (typeof target !== 'string' && !Buffer.isBuffer(target) && !(target instanceof URL)) return;
  const resolved = path.resolve(target instanceof URL ? fileURLToPath(target) : target.toString());
  if (resolved === isolatedIntegrationRoot || resolved.startsWith(`${isolatedIntegrationRoot}${path.sep}`)) return;
  if (protectedDirectories.some((directory) => resolved === directory || resolved.startsWith(`${directory}${path.sep}`))) {
    throw new Error(`Test filesystem mutation outside isolated environment: ${resolved}`);
  }
}

for (const method of ['writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'truncateSync', 'mkdirSync'] as const) {
  const original = fs[method];
  (fs as any)[method] = (target: unknown, ...args: unknown[]) => {
    assertDisposable(target);
    return (original as any)(target, ...args);
  };
}
for (const method of ['renameSync', 'copyFileSync', 'cpSync'] as const) {
  const original = fs[method];
  (fs as any)[method] = (source: unknown, destination: unknown, ...args: unknown[]) => {
    if (method === 'renameSync') assertDisposable(source);
    assertDisposable(destination);
    return (original as any)(source, destination, ...args);
  };
}
const openSync = fs.openSync;
fs.openSync = ((target: fs.PathLike, flags: string | number, ...args: unknown[]) => {
  const writes = typeof flags === 'string'
    ? /[wa+]/.test(flags)
    : !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND));
  if (writes) assertDisposable(target);
  return (openSync as any)(target, flags, ...args);
}) as typeof fs.openSync;

export function resetIntegrationConfig(): void {
  if (os.homedir() !== isolatedIntegrationHome || process.env.MICHI_CONFIG_DIR !== isolatedIntegrationConfigDir) {
    throw new Error('Integration environment must remain isolated before loading configuration');
  }
  fs.writeFileSync(path.join(isolatedIntegrationConfigDir, 'config.json'), '{}');
}

process.on('exit', () => {
  fs.rmSync(isolatedIntegrationRoot, { recursive: true, force: true });
});
