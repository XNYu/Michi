import express, { type NextFunction, type Request, type Response } from 'express';
import { AgentRunContractError } from 'michi-shared';
import { AgentDefinitionService, AgentEnableBlockedError } from '../services/agentDefinitionService';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import {
  requireAgentDefinitionOwner,
} from './middleware/agentOwnership';

export interface CustomAgentRouteDeps {
  service?: AgentDefinitionService;
  definitionOwnerMiddleware?: (req: any, res: Response, next: NextFunction) => void;
}

export { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';

function owner(req: Request): string {
  const id = req.user?.id;
  if (!id) throw new Error('authentication required');
  return id;
}

function operationId(req: Request): string | undefined {
  const header = req.header('x-idempotency-key');
  return header?.trim() || undefined;
}

function agentId(req: Request): string {
  const value = req.params.agentId;
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function errorStatus(err: unknown): number {
  const message = err instanceof Error ? err.message : '';
  if (/authentication required|ownerUserId is required/.test(message)) return 401;
  if (/revision conflict|reused with a different payload/.test(message)) return 409;
  if (err instanceof AgentRunContractError) return 400;
  return 400;
}

export function setupCustomAgentRoutes(deps: CustomAgentRouteDeps = {}): express.Router {
  const router = express.Router();
  const service = deps.service ?? new AgentDefinitionService();
  const requireDefinitionOwner = deps.definitionOwnerMiddleware ?? requireAgentDefinitionOwner;
  const handle = (fn: (req: Request, res: Response) => Promise<void> | void) =>
    async (req: Request, res: Response): Promise<void> => {
      try { await fn(req, res); }
      catch (err) {
        const body: Record<string, unknown> = { error: err instanceof Error ? err.message : 'invalid request' };
        if (err instanceof AgentEnableBlockedError) body.blockers = err.blockers;
        res.status(errorStatus(err)).json(body);
      }
    };

  router.use((req: any, _res, next) => {
    if (!req.user && process.env.MICHI_CLOUD !== '1') req.user = { id: LOCAL_AGENT_OWNER_ID };
    next();
  });

  router.get('/agents', handle((req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
      ? req.query.workspaceId.trim() : null;
    const definitions = req.query.discover === 'enabled'
      ? workspaceId ? service.discoverEnabled(owner(req), workspaceId) : []
      : service.list(owner(req), workspaceId);
    res.json({ definitions });
  }));

  // Browse-time capability catalog: every tool / skill / MCP server visible to
  // this owner in the given Workspace scope, WITH readiness, so the editor can
  // offer chips and flag unresolved refs before enable is attempted.
  router.get('/agent-capabilities', handle((req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
      ? req.query.workspaceId.trim() : null;
    res.json({ capabilities: service.capabilityCatalog.list(owner(req), workspaceId) });
  }));

  router.post('/agents', handle(async (req, res) => {
    const definition = await service.create(owner(req), req.body, operationId(req));
    res.status(201).json({ definition, retention: service.retentionMetadata(definition) });
  }));

  router.get('/agents/:agentId', requireDefinitionOwner, handle((req, res) => {
    const definition = service.get(owner(req), agentId(req));
    if (!definition) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ definition, retention: service.retentionMetadata(definition) });
  }));

  router.patch('/agents/:agentId', requireDefinitionOwner, handle(async (req, res) => {
    const definition = await service.update(owner(req), agentId(req), req.body, operationId(req));
    if (!definition) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ definition, retention: service.retentionMetadata(definition) });
  }));

  router.post('/agents/:agentId/enable', requireDefinitionOwner, handle(async (req, res) => {
    const definition = await service.enable(owner(req), agentId(req), operationId(req));
    if (!definition) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ definition, retention: service.retentionMetadata(definition) });
  }));

  router.post('/agents/:agentId/disable', requireDefinitionOwner, handle((req, res) => {
    const definition = service.disable(owner(req), agentId(req), operationId(req));
    if (!definition) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ definition, retention: service.retentionMetadata(definition) });
  }));

  router.post('/agents/:agentId/duplicate', requireDefinitionOwner, handle((req, res) => {
    const workspaceId = req.body && Object.prototype.hasOwnProperty.call(req.body, 'workspaceId')
      ? req.body.workspaceId as string | null : undefined;
    const definition = service.duplicate(owner(req), agentId(req), workspaceId, operationId(req));
    if (!definition) { res.status(404).json({ error: 'not_found' }); return; }
    res.status(201).json({ definition, retention: service.retentionMetadata(definition) });
  }));

  router.delete('/agents/:agentId', requireDefinitionOwner, handle((req, res) => {
    if (!service.delete(owner(req), agentId(req), operationId(req))) {
      res.status(404).json({ error: 'not_found' }); return;
    }
    res.status(204).end();
  }));

  return router;
}
