/** Authentication and data isolation are separate deployment choices.
 * Local authenticated mode grants one explicitly selected account the same
 * machine-wide access as the desktop app; it does not enable cloud sandboxes. */
export interface AccessPolicy {
  mode: 'local' | 'local-auth' | 'cloud';
  requireAuth: boolean;
  ownerScoped: boolean;
  localAuthEmail?: string;
  adminEmails: readonly string[];
}

export function resolveAccessPolicy(env: NodeJS.ProcessEnv = process.env): AccessPolicy {
  const requireAuth = env.MICHI_REQUIRE_AUTH?.toLowerCase() === 'true';
  const ownerScoped = env.MICHI_CLOUD === '1';
  if (ownerScoped && !requireAuth) {
    throw new Error('MICHI_CLOUD=1 requires MICHI_REQUIRE_AUTH=true. For a local desktop backend, unset MICHI_CLOUD.');
  }
  const localAuthEmail = env.MICHI_LOCAL_AUTH_EMAIL?.trim().toLowerCase();
  if (requireAuth && !ownerScoped && (!localAuthEmail || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(localAuthEmail))) {
    throw new Error('Local authentication requires one MICHI_LOCAL_AUTH_EMAIL. Set that account for machine-wide desktop access, or set MICHI_CLOUD=1 for isolated multi-user hosting.');
  }
  return {
    mode: ownerScoped ? 'cloud' : requireAuth ? 'local-auth' : 'local',
    requireAuth,
    ownerScoped,
    ...(requireAuth && !ownerScoped ? { localAuthEmail } : {}),
    adminEmails: (env.MICHI_ADMIN_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
  };
}

/** Cloud mode isolates accounts. An access configuration resolveAccessPolicy
 * rejects counts as cloud, so feature and permission checks fail closed. */
export function isOwnerScopedAccess(env: NodeJS.ProcessEnv = process.env): boolean {
  try { return resolveAccessPolicy(env).ownerScoped; } catch { return true; }
}

export interface AccessUser { id: string; email?: string; emailVerified?: boolean }

export function isAuthorizedSession(policy: AccessPolicy, user: AccessUser | undefined): boolean {
  if (!user || typeof user.id !== 'string' || !user.id.trim()) return false;
  return policy.mode !== 'local-auth'
    || (user.email?.trim().toLowerCase() === policy.localAuthEmail && user.emailVerified === true);
}

/** Only request adapters use this helper. An absent cloud owner must never
 * reach the repository's intentionally unscoped background APIs. */
export function requestOwnerUserId(req: { user?: { id: string } }): string | undefined {
  if (process.env.MICHI_CLOUD !== '1') return undefined;
  const userId = req.user?.id;
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('Authenticated owner required');
  return userId;
}
