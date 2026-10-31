import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** One page of a folder picker: the folder, its parent and its visible subfolders. */
export interface HostDirectory { path: string; parent: string | null; entries: { name: string; path: string }[] }

const HOST_DIRECTORY_ENTRY_LIMIT = 250;

/** API path a desktop gateway calls through its SSH tunnel; older remotes answer 404. */
export const HOST_DIRECTORIES_PATH = '/host/directories';

export class HostDirectoryError extends Error {
  constructor(readonly code: 'invalid_path' | 'path', message: string) { super(message); }
}

export function validHostDirectoryRequest(requested: string): boolean {
  return requested.length <= 4096 && !/[\r\n\0]/.test(requested);
}

/**
 * Lists the subfolders of a folder on this host for a remote folder picker.
 * Matches the SSH fallback's Python listing in remoteDesktopSetup.ts: `~`
 * expands to home, a relative path resolves against home, symlinks resolve,
 * dot entries are hidden, names sort case-insensitively, and the listing
 * stops at HOST_DIRECTORY_ENTRY_LIMIT folders.
 */
export async function listHostDirectory(requested = '~', home = os.homedir()): Promise<HostDirectory> {
  if (!validHostDirectoryRequest(requested)) throw new HostDirectoryError('invalid_path', 'Invalid folder path.');
  const expanded = requested === '~' ? home
    : requested.startsWith('~/') ? path.join(home, requested.slice(2))
      : requested;
  let folder: string;
  let dirents: Dirent[];
  try {
    folder = await fs.realpath(path.resolve(home, expanded));
    if (!(await fs.stat(folder)).isDirectory()) throw new Error('not a directory');
    dirents = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    throw new HostDirectoryError('path', 'The remote folder does not exist or cannot be read.');
  }
  const entries: HostDirectory['entries'] = [];
  const sorted = dirents.filter(entry => !entry.name.startsWith('.'))
    .map(entry => ({ entry, key: entry.name.toLowerCase() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { entry } of sorted) {
    const entryPath = path.join(folder, entry.name);
    let isDirectory = entry.isDirectory();
    // The entry type avoids a stat per entry (Node itself lstat()s entries a
    // filesystem reports without a type). Only a symlink needs a stat that
    // follows the link, so a link to a folder is listed like the folder.
    if (!isDirectory && entry.isSymbolicLink()) {
      try { isDirectory = (await fs.stat(entryPath)).isDirectory(); } catch { /* Dangling or unreadable entries are skipped. */ }
    }
    if (isDirectory) entries.push({ name: entry.name, path: entryPath });
    if (entries.length >= HOST_DIRECTORY_ENTRY_LIMIT) break;
  }
  const parent = path.dirname(folder);
  return { path: folder, parent: parent === folder ? null : parent, entries };
}
