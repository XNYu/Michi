import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWithinCwd, PathSandboxError } from "../tools/pathSandbox";

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Max bytes a single image may be to display via show_image / the /files serve
 * route. Mirrors the `read` tool's per-image cap (SINGLE_IMAGE_MAX_BYTES) so the
 * two image paths agree, and bounds what the serve route will stream. Shared by
 * `resolveShowImage` here and the serve route in routes/files.ts.
 */
export const SHOW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type ShowImageResult =
  | { ok: true; relPath: string; mimeType: string; size: number }
  | { ok: false; error: string };

/**
 * Validate `inputPath` (relative to or absolute within `cwd`) as a servable
 * image. Returns the cwd-relative path + mimeType, or an error. Display-only:
 * never feeds Claude's context. SVG is excluded (can carry script → XSS).
 */
export function resolveShowImage(cwd: string, inputPath: string): ShowImageResult {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    return { ok: false, error: "path is required" };
  }
  let abs: string;
  try {
    abs = resolveWithinCwd(inputPath, cwd); // resolve + assert inside cwd
  } catch (err) {
    if (err instanceof PathSandboxError) {
      return { ok: false, error: `path is outside the workspace: ${inputPath}` };
    }
    return { ok: false, error: (err as Error).message };
  }
  // Defeat symlink-escape: realpath, then re-assert inside cwd.
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { ok: false, error: `file not found: ${inputPath}` };
  }
  const realCwd = fs.realpathSync(cwd);
  if (real !== realCwd && !real.startsWith(realCwd + path.sep)) {
    return { ok: false, error: `path is outside the workspace: ${inputPath}` };
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) return { ok: false, error: "not a regular file" };
  if (stat.size > SHOW_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      error: `image is ${stat.size} bytes, exceeds the ${SHOW_IMAGE_MAX_BYTES}-byte display limit`,
    };
  }

  const ext = path.extname(real).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXT[ext];
  if (!mimeType) {
    return { ok: false, error: `unsupported image type: ${ext || "(none)"}` };
  }
  const relPath = path.relative(realCwd, real);
  return { ok: true, relPath, mimeType, size: stat.size };
}
