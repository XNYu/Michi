import fs from 'node:fs';
import path from 'node:path';

/** Validate before launching a runtime: Node also reports spawn ENOENT when
 * the executable exists but its working directory has disappeared. */
export function workspaceCwdError(cwd: unknown): { code: 'WORKSPACE_CWD_INVALID'; error: string } | null {
  const invalid = (error: string) => ({ code: 'WORKSPACE_CWD_INVALID' as const, error });
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return invalid('Workspace folder must be an absolute path. Select an existing folder for this Workspace.');
  }
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return invalid(`Workspace folder is not a directory: ${cwd}. Select an existing folder for this Workspace.`);
    }
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return invalid(`Workspace folder does not exist or is not accessible: ${cwd}. Select an existing folder for this Workspace.`);
  }
  return null;
}
