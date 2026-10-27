import path from 'node:path';
import express from 'express';
import type { Express } from 'express';

/**
 * Serves the built frontend from `buildDir`: its files, and `index.html` for
 * any other GET outside `/api/` so the app loads on a deep link.
 *
 * Two kinds of path never get the page, with or without a trailing slash and
 * in any case (Express routes ignore case):
 *  - `/api` and `/api/...`, left to the API routes (and their 404s).
 *  - `/.well-known` and `/.well-known/...` (RFC 8615): protocol discovery,
 *    not the app. An MCP client probes
 *    `/.well-known/oauth-protected-resource/api/mcp/<slot>` before talking to
 *    Michi's MCP endpoint; it gets Express's plain 404 (no OAuth here), never
 *    the HTML page.
 *
 * The page is sent relative to `buildDir` (`root`), so a build that lives
 * under a dot-directory (a checkout in `.worktrees/`) is still served: `send`
 * refuses dotted segments only in the requested part of the path.
 */
const RESERVED = ['/api', '/.well-known'];

function reserved(requestPath: string): boolean {
  const p = requestPath.toLowerCase();
  return RESERVED.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

export function setupSpaFallback(app: Express, buildDir: string): void {
  app.use(express.static(buildDir));
  app.get('/*splat', (req, res, next) => {
    if (reserved(req.path)) return next();
    res.sendFile('index.html', { root: path.resolve(buildDir) });
  });
}
