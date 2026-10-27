import type { Request, RequestHandler } from 'express';
import { isAuthorizedSession, resolveAccessPolicy, type AccessPolicy, type AccessUser } from '../../services/accessPolicy';
import { isInternalRuntimeRequest } from '../../services/remoteAccess';

export const SESSION_PUBLIC_PATHS = [/^\/health$/, /^\/auth\//, /^\/auth-config$/, /^\/diagnostics$/, /^\/ready$/];

type AuthSession = { user: AccessUser & { email: string }; session: { id: string } };

/** The production cookie resolver and isolated HTTP tests share this gate. */
export function createSessionAccessMiddleware(
  policy: AccessPolicy,
  getSession: (req: Request) => Promise<AuthSession | null>,
  onError: (error: unknown) => void = () => {},
): RequestHandler {
  return async (req, res, next) => {
    if (!policy.requireAuth || SESSION_PUBLIC_PATHS.some(pattern => pattern.test(req.path))) return next();
    // Desktop CLIs do not own browser cookies. These loopback-only capability
    // routes authorize their own unguessable slot/group and turn binding.
    if (policy.mode === 'local-auth' && isInternalRuntimeRequest(req.path, req.socket.remoteAddress)) return next();
    try {
      const session = await getSession(req);
      if (!session || !isAuthorizedSession(policy, session.user)) return res.status(401).json({ error: 'unauthorized' });
      req.authUser = session.user;
      // Existing desktop paths use an absent owner for local provider keys,
      // NULL-owned legacy workspaces, and the fixed local Agent identity.
      req.user = policy.ownerScoped ? session.user : undefined;
      req.session = session.session;
      next();
    } catch (error) {
      onError(error);
      res.status(401).json({ error: 'unauthorized' });
    }
  };
}

/** Defense for routers mounted independently of server.ts. Cloud fixture apps
 * can inject their already authenticated user; no missing owner falls back to
 * a trusted repository read. Production validates the full policy at boot. */
export const requireRequestAccess: RequestHandler = (req, res, next) => {
  const authenticated = process.env.MICHI_REQUIRE_AUTH?.toLowerCase() === 'true';
  if (!authenticated && process.env.MICHI_CLOUD !== '1') return next();
  const principal = req.authUser ?? req.user;
  if (!principal?.id?.trim()) return res.status(401).json({ error: 'unauthorized' });
  if (authenticated && process.env.MICHI_CLOUD !== '1') {
    try {
      if (!isAuthorizedSession(resolveAccessPolicy(), principal)) return res.status(401).json({ error: 'unauthorized' });
      req.authUser = principal;
      req.user = undefined;
    } catch {
      return res.status(503).json({ error: 'Access mode is misconfigured' });
    }
  }
  if (process.env.MICHI_CLOUD === '1' && !req.user?.id?.trim()) return res.status(401).json({ error: 'unauthorized' });
  next();
};
