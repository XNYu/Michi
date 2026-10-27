import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type JsonConfig = Record<string, any>;

export type JsonConfigErrorCode = 'CONFIG_LOCKED' | 'CONFIG_CORRUPT' | 'CONFIG_READ_FAILED' | 'CONFIG_WRITE_FAILED';

export class JsonConfigError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly operation: 'read' | 'write',
    cause: unknown,
    public readonly code: JsonConfigErrorCode = operation === 'read' ? 'CONFIG_READ_FAILED' : 'CONFIG_WRITE_FAILED',
  ) {
    const detail = code === 'CONFIG_LOCKED' ? `Configuration is locked: ${filePath}.lock`
      : code === 'CONFIG_CORRUPT' ? `Invalid JSON configuration: ${filePath}`
      : `Failed to ${operation} JSON configuration: ${filePath}`;
    // Never put file contents (which may contain credentials) in an error.
    super(detail, { cause });
    this.name = 'JsonConfigError';
  }
}

/** Only ENOENT means a new config. Corruption, invalid shape and permissions fail closed. */
export function readJsonConfig(filePath: string): JsonConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new JsonConfigError(filePath, 'read', error);
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
    return value as JsonConfig;
  } catch (error) {
    // SyntaxError messages may contain snippets of the secret-bearing input.
    throw new JsonConfigError(filePath, 'read', new Error('Expected a valid JSON object'), 'CONFIG_CORRUPT');
  }
}

const LOCK_WAIT_MS = 250;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * Cooperating processes serialize updates via an exclusive sibling lock. Waiting
 * is bounded because these public config APIs are synchronous. Orphaned/unknown
 * locks fail closed: no PID/age heuristic can safely prove that an owner is dead
 * on every supported platform (including PID reuse). They require operator repair.
 */
function withConfigLock<T>(filePath: string, run: () => T): T {
  const lockPath = `${filePath}.lock`;
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let fd: number | undefined;
  let executing = false;
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    for (;;) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new JsonConfigError(filePath, 'write', new Error('Writer lock wait exceeded 250ms; see README configuration recovery'), 'CONFIG_LOCKED');
        Atomics.wait(lockWaitBuffer, 0, 0, Math.min(10, remaining));
      }
    }
    fs.writeFileSync(fd, token);
    executing = true;
    return run();
  } catch (error) {
    if (executing || error instanceof JsonConfigError) throw error;
    throw new JsonConfigError(filePath, 'write', error);
  } finally {
    if (fd !== undefined) {
      try {
        // A token-write failure must also release our own exclusive inode.
        const held = fs.fstatSync(fd);
        const current = fs.lstatSync(lockPath);
        if (held.dev === current.dev && held.ino === current.ino) fs.unlinkSync(lockPath);
      } catch { /* never delete an unknown replacement */ }
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Readers see a complete old/new document, with credential-safe permissions. */
function replaceJsonConfig(filePath: string, value: JsonConfig): void {
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const data = JSON.stringify(value, null, 2);
    fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, filePath);
  } catch (error) {
    throw new JsonConfigError(filePath, 'write', error);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* successful rename or failed creation */ }
  }
}

/** Explicit whole-document replacement still refuses to overwrite unreadable data. */
export function writeJsonConfig(filePath: string, value: JsonConfig): void {
  withConfigLock(filePath, () => {
    readJsonConfig(filePath);
    replaceJsonConfig(filePath, value);
  });
}

/** The lock covers read, namespace mutation and atomic replacement across processes. */
export function updateJsonConfig(filePath: string, update: (existing: JsonConfig) => JsonConfig): JsonConfig {
  return withConfigLock(filePath, () => {
    const next = update(readJsonConfig(filePath) ?? {});
    replaceJsonConfig(filePath, next);
    return next;
  });
}
