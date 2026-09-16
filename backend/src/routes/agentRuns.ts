import express, { type Request, type Response } from 'express';
import {
  AgentRunContractError,
  parseAgentRunInputRequestV1,
  parseAgentRunListQueryV1,
  parseCancelAgentRunRequestV1,
  parseCreateAgentRunWatchRequestV1,
  parseRespondAgentRunInteractionRequestV1,
  parseSpawnAgentRunRequestV1,
  parseUpdateAgentRunWatchRequestV1,
  type AgentRunAttemptDtoV1,
  type AgentRunDtoV1,
  type AgentRunEventV1,
  type AgentRunInputRequestV1,
  type AgentRunInteractionDtoV1,
  type AgentRunListQueryV1,
  type AgentRunWatchDtoV1,
  type CancelAgentRunRequestV1,
  type CreateAgentRunWatchRequestV1,
  type RespondAgentRunInteractionRequestV1,
  type SpawnAgentRunRequestV1,
  type UpdateAgentRunWatchRequestV1,
} from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { AgentRunCoordinator } from '../agents/runs/agentRunCoordinator';
import { AgentRunWatchCoordinator } from '../agents/runs/agentRunWatchCoordinator';
import { AgentRunsRepository } from '../services/agentRunsRepository';
import { createAgentRunSseHandler, type AgentRunSseDeps } from './agentRunSse';
import { AgentRunActionsService } from '../services/agentRunActions';
import { mountAgentRunActionRoutes } from './agentRunActions';
import {
  requireAgentRunInteractionOwner,
  requireAgentRunOwner,
  requireAgentRunWatchOwner,
} from './middleware/agentOwnership';
import type { NextFunction } from 'express';

export interface AgentRunDetailV1 {
  run: AgentRunDtoV1;
  attempts: AgentRunAttemptDtoV1[];
  events: AgentRunEventV1[];
  interactions: AgentRunInteractionDtoV1[];
}

export interface AgentRunRouteService {
  spawn(ownerUserId: string, request: SpawnAgentRunRequestV1, operationId: string): Promise<AgentRunDtoV1>;
  list(ownerUserId: string, query: AgentRunListQueryV1): AgentRunDtoV1[];
  getDetail(ownerUserId: string, runId: string): AgentRunDetailV1 | null;
  events(ownerUserId: string, runId: string, afterSeq: number): AgentRunEventV1[] | null;
  input(ownerUserId: string, runId: string, request: AgentRunInputRequestV1, operationId: string): Promise<boolean>;
  cancel(ownerUserId: string, runId: string, request: CancelAgentRunRequestV1, operationId: string): Promise<boolean>;
  respond(ownerUserId: string, runId: string, interactionId: string, request: RespondAgentRunInteractionRequestV1, operationId: string): Promise<AgentRunInteractionDtoV1 | null>;
  createWatch(ownerUserId: string, request: CreateAgentRunWatchRequestV1, operationId: string): AgentRunWatchDtoV1;
  updateWatch(ownerUserId: string, watchId: string, request: UpdateAgentRunWatchRequestV1, operationId: string): AgentRunWatchDtoV1 | null;
}

export interface AgentRunRouteDeps {
  service: AgentRunRouteService;
  sse: AgentRunSseDeps;
  createOperationId?: () => string;
  actions?: AgentRunActionsService;
  isEnabled?: () => boolean;
  ownership?: {
    run: (req: Request, res: Response, next: NextFunction) => void;
    interaction: (req: Request, res: Response, next: NextFunction) => void;
    watch: (req: Request, res: Response, next: NextFunction) => void;
  };
}

export class AgentRunApiService implements AgentRunRouteService {
  constructor(
    private readonly coordinator: AgentRunCoordinator,
    private readonly repository: AgentRunsRepository,
    private readonly watches: AgentRunWatchCoordinator,
  ) {}

  async spawn(ownerUserId: string, request: SpawnAgentRunRequestV1, operationId: string): Promise<AgentRunDtoV1> {
    const run = await this.coordinator.spawn({
      operationId, ownerUserId, workspaceId: request.workspaceId,
      definitionId: request.agentId, ephemeralDefinition: request.ephemeralDefinition,
      invocationMode: request.invocationMode, completionMode: request.completionMode,
      parentRunId: request.parentRunId, parentAttemptId: request.parentAttemptId, parentNodeId: request.parentNodeId,
      parentTurnId: request.parentTurnId, parentMessageId: request.parentMessageId,
      parentToolCallId: request.parentToolCallId, task: request.task,
      contextManifest: request.contextManifest, permissionRestriction: request.permissionRestriction,
      environment: request.environment, expectedResult: request.expectedResult, runTtlMs: request.runTtlMs,
    });
    void this.coordinator.start(ownerUserId, run.id).catch(() => undefined);
    return run;
  }

  list(ownerUserId: string, query: AgentRunListQueryV1): AgentRunDtoV1[] { return this.repository.listRuns(ownerUserId, query); }
  getDetail(ownerUserId: string, runId: string): AgentRunDetailV1 | null {
    const run = this.repository.getRun(ownerUserId, runId);
    if (!run) return null;
    return { run, attempts: this.repository.listAttempts(ownerUserId, runId), events: this.repository.listEvents(ownerUserId, runId), interactions: this.repository.listInteractions(ownerUserId, runId) };
  }
  events(ownerUserId: string, runId: string, afterSeq: number): AgentRunEventV1[] | null {
    return this.repository.getRun(ownerUserId, runId) ? this.repository.listEvents(ownerUserId, runId, afterSeq, 1_000) : null;
  }
  input(ownerUserId: string, runId: string, request: AgentRunInputRequestV1, operationId: string): Promise<boolean> { return this.coordinator.input(ownerUserId, runId, request, operationId); }
  cancel(ownerUserId: string, runId: string, request: CancelAgentRunRequestV1, operationId: string): Promise<boolean> { return this.coordinator.cancel(ownerUserId, runId, request.reason, request.expectedAttemptId, operationId); }
  respond(ownerUserId: string, runId: string, interactionId: string, request: RespondAgentRunInteractionRequestV1, operationId: string): Promise<AgentRunInteractionDtoV1 | null> { return this.coordinator.respondInteraction(ownerUserId, runId, interactionId, request.response, operationId); }
  createWatch(ownerUserId: string, request: CreateAgentRunWatchRequestV1, operationId: string): AgentRunWatchDtoV1 {
    return this.watches.create(ownerUserId, request.workspaceId, request.runIds, request.condition, request.completionMode, {
      parentRunId: request.parentRunId, parentNodeId: request.parentNodeId, parentTurnId: request.parentTurnId,
    }, operationId);
  }
  updateWatch(ownerUserId: string, watchId: string, request: UpdateAgentRunWatchRequestV1, _operationId: string): AgentRunWatchDtoV1 | null {
    return this.repository.updateWatch(ownerUserId, watchId, request.addRunIds, request.condition);
  }
}

function owner(req: Request): string {
  const value = req.user?.id;
  if (!value) throw new Error('authentication required');
  return value;
}

function routeId(req: Request, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function status(error: unknown): number {
  if (error instanceof AgentRunContractError) return 400;
  const message = error instanceof Error ? error.message : '';
  if (/authentication required/.test(message)) return 401;
  if (/conflict|reused with a different payload|expected Attempt/.test(message)) return 409;
  return 400;
}

function readListQuery(req: Request): AgentRunListQueryV1 {
  const rawStatuses = req.query.status;
  const statuses = rawStatuses === undefined ? undefined : Array.isArray(rawStatuses) ? rawStatuses : [rawStatuses];
  const limit = typeof req.query.limit === 'string' && req.query.limit ? Number(req.query.limit) : undefined;
  const includeArchived = req.query.includeArchived === undefined ? undefined
    : req.query.includeArchived === 'true' ? true
      : req.query.includeArchived === 'false' ? false : req.query.includeArchived;
  return parseAgentRunListQueryV1({
    version: 1, workspaceId: req.query.workspaceId,
    ...(statuses === undefined ? {} : { statuses }),
    ...(typeof req.query.q === 'string' ? { q: req.query.q } : {}),
    ...(includeArchived === undefined ? {} : { includeArchived }),
    ...(limit === undefined ? {} : { limit }),
    ...(typeof req.query.cursor === 'string' ? { cursor: req.query.cursor } : {}),
  });
}

export function setupAgentRunRoutes(deps: AgentRunRouteDeps): express.Router {
  const router = express.Router();
  let generated = 0;
  const operationId = (req: Request): string => {
    const value = req.header('x-idempotency-key')?.trim()
      || deps.createOperationId?.() || `agent-run-route-${Date.now()}-${++generated}`;
    if (value.length > 256) throw new Error('idempotency key must be at most 256 characters');
    return value;
  };
  const handle = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response): Promise<void> => {
    try { await fn(req, res); }
    catch (error) { res.status(status(error)).json({ error: error instanceof Error ? error.message : 'invalid request' }); }
  };
  const routeRoots = ['/agent-runs', '/agent-run-watches'];
  router.use(routeRoots, (_req, res, next) => {
    if (deps.isEnabled?.() === false) {
      res.status(404).json({ error: 'custom_agents_disabled' });
      return;
    }
    next();
  });
  router.use(routeRoots, (req: any, _res, next) => { if (!req.user && process.env.MICHI_CLOUD !== '1') req.user = { id: LOCAL_AGENT_OWNER_ID }; next(); });
  const ownership = deps.ownership ?? {
    run: requireAgentRunOwner,
    interaction: requireAgentRunInteractionOwner,
    watch: requireAgentRunWatchOwner,
  };

  router.get('/agent-runs/subscribe', createAgentRunSseHandler(deps.sse));
  router.get('/agent-runs', handle((req, res) => { res.json({ runs: deps.service.list(owner(req), readListQuery(req)) }); }));
  router.post('/agent-runs', handle(async (req, res) => {
    const run = await deps.service.spawn(owner(req), parseSpawnAgentRunRequestV1(req.body), operationId(req));
    res.status(201).json({ run });
  }));
  router.post('/agent-run-watches', handle((req, res) => {
    const watch = deps.service.createWatch(owner(req), parseCreateAgentRunWatchRequestV1(req.body), operationId(req));
    res.status(201).json({ watch });
  }));

  router.use('/agent-runs/:runId/interactions/:interactionId', ownership.interaction);
  router.use('/agent-runs/:runId', ownership.run);
  router.use('/agent-run-watches/:watchId', ownership.watch);
  mountAgentRunActionRoutes(router, { actions: deps.actions ?? new AgentRunActionsService(), operationId });

  router.get('/agent-runs/:runId', handle((req, res) => {
    const detail = deps.service.getDetail(owner(req), routeId(req, 'runId'));
    if (!detail) { res.status(404).json({ error: 'not_found' }); return; }
    res.json(detail);
  }));
  router.get('/agent-runs/:runId/events', handle((req, res) => {
    const raw = typeof req.query.afterSeq === 'string' ? Number(req.query.afterSeq) : -1;
    if (!Number.isSafeInteger(raw) || raw < -1) throw new Error('afterSeq must be an integer >= -1');
    const events = deps.service.events(owner(req), routeId(req, 'runId'), raw);
    if (!events) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ events });
  }));
  router.post('/agent-runs/:runId/input', handle(async (req, res) => {
    if (!await deps.service.input(owner(req), routeId(req, 'runId'), parseAgentRunInputRequestV1(req.body), operationId(req))) { res.status(404).json({ error: 'not_found' }); return; }
    res.status(202).json({ accepted: true });
  }));
  router.post('/agent-runs/:runId/cancel', handle(async (req, res) => {
    if (!await deps.service.cancel(owner(req), routeId(req, 'runId'), parseCancelAgentRunRequestV1(req.body), operationId(req))) { res.status(404).json({ error: 'not_found' }); return; }
    res.status(202).json({ accepted: true });
  }));
  router.post('/agent-runs/:runId/interactions/:interactionId/respond', handle(async (req, res) => {
    const interaction = await deps.service.respond(owner(req), routeId(req, 'runId'), routeId(req, 'interactionId'), parseRespondAgentRunInteractionRequestV1(req.body), operationId(req));
    if (!interaction) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ interaction });
  }));
  router.patch('/agent-run-watches/:watchId', handle((req, res) => {
    const watch = deps.service.updateWatch(owner(req), routeId(req, 'watchId'), parseUpdateAgentRunWatchRequestV1(req.body), operationId(req));
    if (!watch) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ watch });
  }));
  return router;
}
