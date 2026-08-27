import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { getMichiDataDir } from './dataDir';

const INTERNAL_RUNTIME_PATHS = [
  /^(?:\/api)?\/mcp\/[^/]+$/,
  /^(?:\/api)?\/codex-hooks\/[^/]+\/stop$/,
];

export function remoteAccessEnabled(): boolean {
  return process.env.MICHI_REMOTE_ACCESS === '1';
}

export function remoteAccessToken(): string | null {
  const token = process.env.MICHI_REMOTE_TOKEN?.trim();
  return token ? token : null;
}

export function resolveListenHost(): string {
  const explicit = process.env.MICHI_BIND_HOST?.trim();
  if (explicit) {
    if (explicit.length > 255 || /[\s/]/.test(explicit)) {
      throw new Error('MICHI_BIND_HOST is invalid');
    }
    return explicit;
  }
  return remoteAccessEnabled() || process.env.MICHI_CLOUD === '1'
    ? '0.0.0.0'
    : '127.0.0.1';
}

export function validateRemoteAccessConfiguration(): void {
  if (!remoteAccessEnabled()) return;
  const token = remoteAccessToken();
  if (!token) {
    throw new Error('MICHI_REMOTE_ACCESS=1 requires MICHI_REMOTE_TOKEN');
  }
  if (token.length < 16) {
    throw new Error('MICHI_REMOTE_TOKEN must be at least 16 characters');
  }
  if ((process.env.MICHI_REQUIRE_AUTH || '').toLowerCase() === 'true') {
    throw new Error('MICHI_REMOTE_ACCESS and MICHI_REQUIRE_AUTH cannot be enabled together');
  }
}

function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function isInternalRuntimeRequest(path: string, remoteAddress: string | undefined): boolean {
  return isLoopbackAddress(remoteAddress)
    && INTERNAL_RUNTIME_PATHS.some((pattern) => pattern.test(path));
}

export function createRemoteAccessMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (!remoteAccessEnabled()) return next();
    // Claude, Kiro, and Codex call Michi's per-session MCP capability URL from
    // child processes on this host. Those requests must keep working when the
    // external API is protected by MICHI_REMOTE_TOKEN. The exception is narrow:
    // loopback only, internal routes only, and the MCP layer still requires the
    // unguessable per-session slot id. Normal API calls arriving through an SSH
    // tunnel are also loopback, but do not match these paths and still require
    // the external bearer token below.
    if (isInternalRuntimeRequest(req.path, req.socket?.remoteAddress)) return next();
    const expected = remoteAccessToken();
    if (!expected) return res.status(503).json({ error: 'remote access is misconfigured' });
    const header = req.headers.authorization;
    const actual = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : '';
    if (!actual || !secureEqual(actual, expected)) {
      return res.status(401).json({ error: 'invalid remote access token' });
    }
    next();
  };
}

export function remoteServerId(): string {
  return createHash('sha256').update(getMichiDataDir()).digest('hex').slice(0, 16);
}
