import type { Request, Response, NextFunction } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (process.env.MICHI_CLOUD !== '1') return next();  // desktop: no-op
  const allowed = (process.env.MICHI_ADMIN_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const email = req.user?.email?.toLowerCase();
  if (!email || !allowed.includes(email)) {
    return res.status(404).json({ error: 'not_found' });  // 404, not 403
  }
  next();
}
