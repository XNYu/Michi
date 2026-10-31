import type { Request, Response, NextFunction } from 'express';
import { isAuthorizedSession, resolveAccessPolicy } from '../../services/accessPolicy';

/** Whether this request's principal is an admin; requireAdmin's one rule. */
export function isAdminRequest(req: Request): boolean {
  // Admin is unavailable without session auth, even in local mode. The
  // separate allowlist applies equally to local-auth and cloud deployments.
  let policy;
  try { policy = resolveAccessPolicy(); } catch { return false; }
  const principal = req.authUser ?? req.user;
  const email = principal?.email?.trim().toLowerCase();
  return policy.requireAuth && isAuthorizedSession(policy, principal) && principal?.emailVerified === true
    && !!email && policy.adminEmails.includes(email);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdminRequest(req)) return res.status(404).json({ error: 'not_found' });  // 404, not 403
  next();
}
