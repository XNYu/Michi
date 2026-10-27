import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { deriveSandboxCwd, NotFoundError, PathSandboxError } from '../agents/tools/pathSandbox';
import { getWorkspace } from './dbRepository';

export const WORKSPACE_FILE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SHARED_UPLOAD_ROOT = '/shared/michi/files';

export function desktopUploadRoot(): string {
  try {
    if (fs.statSync(path.dirname(SHARED_UPLOAD_ROOT)).isDirectory()) return SHARED_UPLOAD_ROOT;
  } catch { /* shared volume is optional */ }
  return path.join(os.tmpdir(), 'michi', 'files');
}

function directoryExists(dir: string): boolean {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/**
 * One root policy for HTTP files, artifacts, diffs and upload allocation.
 * A saved session cwd wins. Otherwise retain an existing upload directory;
 * legacy Electron scratch directories are used only when no upload exists.
 * Allocation may precede desktop workspace persistence, while reads require a row.
 * Cloud roots always verify ownership, including on allocation.
 */
export function resolveWorkspaceFileRoot(
  req: Pick<Request, 'user'>,
  workspaceId: string,
  options: { allocate?: boolean } = {},
): string {
  if (!WORKSPACE_FILE_ID_RE.test(workspaceId)) throw new NotFoundError(workspaceId);
  if (process.env.MICHI_CLOUD === '1') {
    if (!req.user?.id) throw new NotFoundError(workspaceId);
    return deriveSandboxCwd(req.user.id, workspaceId);
  }
  const workspace = getWorkspace(workspaceId);
  if (!workspace && !options.allocate) throw new NotFoundError(workspaceId);
  let root: string;
  if (typeof workspace?.cwd === 'string' && workspace.cwd.trim()) {
    root = workspace.cwd;
  } else {
    const upload = path.join(desktopUploadRoot(), workspaceId);
    const scratch = path.join(os.homedir(), '.michi', 'workspaces', workspaceId);
    root = directoryExists(upload) ? upload : directoryExists(scratch) ? scratch : upload;
  }
  if (options.allocate) fs.mkdirSync(root, { recursive: true });
  return path.resolve(root);
}

function assertContained(candidate: string, root: string): void {
  const rel = path.relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PathSandboxError(candidate, root);
  }
}

/** HTTP input is already decoded once by Express. Never expand mentions/home,
 * normalize Unicode spaces, decode again, or interpret Windows separators.
 */
export function resolveHttpWorkspacePath(relativePath: string, root: string): string {
  const segments = relativePath.split('/');
  if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0')
    || /^[a-zA-Z]:/.test(relativePath)
    || segments.some((segment) => !segment || segment.startsWith('~') || segment.startsWith('@'))) {
    throw new PathSandboxError(relativePath, root);
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  assertContained(candidate, resolvedRoot);
  return candidate;
}

/** Resolve the longest existing prefix, also protecting diffs of deleted files. */
export function assertWorkspaceRealpath(candidate: string, root: string): string {
  const realRoot = fs.realpathSync(root);
  let cursor = candidate;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = path.join(fs.realpathSync(cursor), ...missing.reverse());
      assertContained(real, realRoot);
      return real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink must not be treated as a merely missing file.
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new PathSandboxError(candidate, root); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function resolveWorkspaceRegularFile(relativePath: string, root: string): { realPath: string; stat: fs.Stats } {
  const realPath = assertWorkspaceRealpath(resolveHttpWorkspacePath(relativePath, root), root);
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw new PathSandboxError(relativePath, root);
  return { realPath, stat };
}
