import type { Request, Response, NextFunction } from 'express';
import { isAuthorizedSession, resolveAccessPolicy } from '../../services/accessPolicy';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // Admin is unavailable without session auth, even in local mode. The
  // separate allowlist applies equally to local-auth and cloud deployments.
  let policy;
  try { policy = resolveAccessPolicy(); } catch { return res.status(404).json({ error: 'not_found' }); }
  const principal = req.authUser ?? req.user;
  const email = principal?.email?.trim().toLowerCase();
  if (!policy.requireAuth || !isAuthorizedSession(policy, principal) || principal?.emailVerified !== true || !email || !policy.adminEmails.includes(email)) {
    return res.status(404).json({ error: 'not_found' });  // 404, not 403
  }
  next();
}
