import type { NextFunction, Response } from 'express';
import { getDb } from '../../services/db';

type AgentResource = 'definition' | 'run' | 'interaction' | 'watch';

function requireOwner(req: any, res: Response, next: NextFunction, resource: AgentResource): void {
  const ownerUserId = req.user?.id;
  if (!ownerUserId) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const config = resource === 'definition'
    ? { values: [req.params?.agentId, ownerUserId], sql: 'SELECT 1 FROM agent_definitions WHERE id = ? AND owner_user_id = ?' }
    : resource === 'run'
      ? { values: [req.params?.runId, ownerUserId], sql: 'SELECT 1 FROM agent_runs WHERE id = ? AND owner_user_id = ?' }
      : resource === 'interaction'
        ? { values: [req.params?.interactionId, req.params?.runId, ownerUserId], sql: `SELECT 1 FROM agent_run_interactions i JOIN agent_runs r ON r.id = i.run_id
            WHERE i.id = ? AND i.run_id = ? AND r.owner_user_id = ?` }
        : { values: [req.params?.watchId, ownerUserId], sql: 'SELECT 1 FROM agent_run_watches WHERE id = ? AND owner_user_id = ?' };
  if (config.values.some((value) => typeof value !== 'string' || !value)
    || !getDb().prepare(config.sql).get(...config.values)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  next();
}

export const requireAgentDefinitionOwner = (req: any, res: Response, next: NextFunction): void =>
  requireOwner(req, res, next, 'definition');
export const requireAgentRunOwner = (req: any, res: Response, next: NextFunction): void =>
  requireOwner(req, res, next, 'run');
export const requireAgentRunInteractionOwner = (req: any, res: Response, next: NextFunction): void =>
  requireOwner(req, res, next, 'interaction');
export const requireAgentRunWatchOwner = (req: any, res: Response, next: NextFunction): void =>
  requireOwner(req, res, next, 'watch');
