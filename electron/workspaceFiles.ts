import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceFileTreeEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}

export function pathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function allowedRealRoots(rawRoots: unknown): Promise<string[]> {
  if (!Array.isArray(rawRoots)) return [];
  const roots = await Promise.all(rawRoots
    .filter((root): root is string => typeof root === 'string' && path.isAbsolute(root))
    .map(async (root) => {
      try {
        const real = await fs.promises.realpath(root);
        return (await fs.promises.stat(real)).isDirectory() ? real : null;
      } catch {
        return null;
      }
    }));
  return [...new Set(roots.filter((root): root is string => root !== null))];
}

export async function resolveAllowedDirectory(absPath: unknown, rawRoots: unknown): Promise<{ directory: string; roots: string[] }> {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) throw new Error('Absolute directory path required');
  const roots = await allowedRealRoots(rawRoots);
  if (roots.length === 0) throw new Error('No workspace folders are available');
  const directory = await fs.promises.realpath(absPath);
  if (!roots.some((root) => pathInsideRoot(directory, root))) throw new Error('Directory is outside this workspace');
  if (!(await fs.promises.stat(directory)).isDirectory()) throw new Error('Path is not a directory');
  return { directory, roots };
}

export async function listWorkspaceDirectory(absPath: unknown, rawRoots: unknown): Promise<WorkspaceFileTreeEntry[]> {
  const { directory, roots } = await resolveAllowedDirectory(absPath, rawRoots);
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const visible = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const real = await fs.promises.realpath(entryPath);
        if (!roots.some((root) => pathInsideRoot(real, root))) return null;
        const stat = await fs.promises.stat(real);
        return { name: entry.name, path: entryPath, kind: stat.isDirectory() ? 'directory' as const : 'file' as const };
      } catch {
        return null;
      }
    }
    if (!entry.isDirectory() && !entry.isFile()) return null;
    return { name: entry.name, path: entryPath, kind: entry.isDirectory() ? 'directory' as const : 'file' as const };
  }));
  return visible
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : a.kind === 'directory' ? -1 : 1);
}
