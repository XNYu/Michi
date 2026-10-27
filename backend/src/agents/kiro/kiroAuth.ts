import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { KiroSignedOutError, isKiroSignInError } from 'michi-runtime/internal/adapters/kiro/kiroSignIn';
export { KiroSignedOutError, isKiroSignInError } from 'michi-runtime/internal/adapters/kiro/kiroSignIn';

export interface KiroCredentialState {
  /** Opaque in-memory change detector, never logged or persisted. */
  fingerprint: string;
  configured: boolean | 'unknown';
}

export function kiroCredentialPaths(platform = process.platform, home = homedir(), env = process.env): string[] {
  const roots = platform === 'darwin' ? [join(home, 'Library', 'Application Support')]
    : platform === 'win32' ? [env.LOCALAPPDATA || join(home, 'AppData', 'Local'), env.APPDATA || join(home, 'AppData', 'Roaming')]
    : [env.XDG_DATA_HOME || join(home, '.local', 'share')];
  return roots.map(root => join(root, 'kiro-cli', 'data.sqlite3'));
}

/**
 * Never invoke whoami: some Kiro launchers open a browser even for that command.
 * Read only the CLI's auth table, not its history or general database mtime.
 * Presence permits a start; it does not assert the token is valid. An explicit
 * runtime auth failure latches below until the credential bytes change.
 */
export function readKiroCredentials(paths = kiroCredentialPaths(), apiKey = process.env.KIRO_API_KEY): KiroCredentialState {
  const hash = createHash('sha256');
  if (apiKey?.trim()) return { configured: true, fingerprint: hash.update(apiKey).digest('hex') };
  let configured = false;
  let unknown = false;
  for (const path of paths) {
    hash.update(path);
    if (!existsSync(path)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA busy_timeout=100');
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_kv'").get()) {
        unknown = true;
        continue;
      }
      const rows = db.prepare('SELECT key, value FROM auth_kv ORDER BY key').all();
      configured ||= rows.length > 0;
      // Only a digest survives this function; no tokens reach errors or logs.
      for (const row of rows) hash.update(JSON.stringify([row.key, row.value]));
    } catch {
      // A locked store or future schema is not evidence of sign-out. Permit
      // one attempt; explicit CLI auth failures still stop subsequent starts.
      unknown = true;
    } finally { db?.close(); }
  }
  hash.update(unknown ? 'unknown' : 'known');
  return { configured: configured || (unknown ? 'unknown' : false), fingerprint: hash.digest('hex') };
}

/** Shared across cwd pools, first-run workers, maintenance workers and restores. */
export class KiroAuthGate {
  private blocked = new Map<string, string>();
  private queues = new Map<string, Promise<void>>();
  constructor(private readonly read: () => KiroCredentialState = readKiroCredentials) {}

  signedOut(binary: string): void {
    this.blocked.set(binary, this.read().fingerprint);
  }

  async start(binary: string, launch: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(binary) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(binary, current);
    await previous;
    try {
      const state = this.read();
      if (state.configured === false || this.blocked.get(binary) === state.fingerprint
        || (state.configured === 'unknown' && this.blocked.has(binary))) throw new KiroSignedOutError();
      this.blocked.delete(binary);
      try { await launch(); }
      catch (error) {
        // A login may finish while the old process is failing. Block the
        // credentials that started it, not the replacement login.
        if (isKiroSignInError(error)) this.blocked.set(binary, state.fingerprint);
        throw error;
      }
    } finally {
      release();
      if (this.queues.get(binary) === current) this.queues.delete(binary);
    }
  }
}

export const kiroAuth = new KiroAuthGate();
