/**
 * Ownership middleware — cloud-mode (MICHI_CLOUD=1) only.
 *
 * All three helpers are no-ops when MICHI_CLOUD !== '1', so desktop mode
 * keeps working exactly as before with zero overhead.
 *
 * On mismatch we return 404 (not 403) to hide the existence of other
 * users' workspaces from an authenticated-but-wrong-user caller.
 */

import type { Request, Response, NextFunction } from 'express';
import { getWorkspace, getNodeWorkspaceId, getNodeSessionBinding } from '../../services/dbRepository';
import { getSessionForUser } from '../../agents/sessionRegistry';

/** Resolves a workspaceId from the request, checks ownership, calls next() or
 *  returns 400/404. Reads from:
 *    1. req.params.id
 *    2. req.params.workspaceId
 *    3. req.body.workspaceId
 */
export function requireWorkspaceOwner(req: any, res: Response, next: NextFunction): void {
  if (process.env.MICHI_CLOUD !== '1') { next(); return; }

  const wsId: string | undefined =
    req.params?.id ||
    req.params?.workspaceId ||
    (req.body && typeof req.body === 'object' ? req.body.workspaceId : undefined);

  if (!wsId) {
    res.status(400).json({ error: 'workspaceId required' });
    return;
  }

  const row = getWorkspace(wsId);
  if (!row || row.owner_user_id !== req.user?.id) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  next();
}

/** For routes with :chatId in params. A runtime id may be stored in
 * `acp_session_id` or `external_session_id`, so authorize against the
 * persisted runtime binding rather than assuming `chatId === nodeId`.
 *
 * Cloud routes must never allow an unknown id through merely because it has
 * not reached SQLite. A same-owner live registry entry is the narrow race
 * exception while an ensure-session response is being persisted. */
export function requireChatOwner(req: any, res: Response, next: NextFunction): void {
  if (process.env.MICHI_CLOUD !== '1') { next(); return; }

  const chatId: string | undefined = req.params?.chatId;
  if (!chatId) {
    res.status(400).json({ error: 'chatId required' });
    return;
  }

  const userId = req.user?.id;
  const persistedBinding = getNodeSessionBinding(chatId, userId);
  const liveSession = getSessionForUser(chatId, userId ?? null);
  if (!persistedBinding && !liveSession) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  next();
}

/** For routes with :nodeId in params. Same logic as requireChatOwner. */
export function requireNodeOwner(req: any, res: Response, next: NextFunction): void {
  if (process.env.MICHI_CLOUD !== '1') { next(); return; }

  const nodeId: string | undefined = req.params?.nodeId;
  if (!nodeId) {
    res.status(400).json({ error: 'nodeId required' });
    return;
  }

  const workspaceId = getNodeWorkspaceId(nodeId);
  if (!workspaceId) {
    // Node not yet in DB — let the route's own not-found logic fire.
    next();
    return;
  }

  const row = getWorkspace(workspaceId);
  if (!row || row.owner_user_id !== req.user?.id) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  next();
}
