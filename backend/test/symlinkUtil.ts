import fs from "node:fs";

/** Create a symlink, or return false when the host forbids them (typical on Windows). */
export function trySymlinkSync(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}
