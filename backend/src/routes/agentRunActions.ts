import type express from 'express';
import { AgentRunActionError, AgentRunActionsService, type ContinueAgentRunRequestV1,
  type SaveAgentRunAsDefinitionRequestV1 } from '../services/agentRunActions';

export interface AgentRunActionRouteDeps {
  actions: AgentRunActionsService;
  operationId(req: express.Request): string;
}

function owner(req: express.Request): string {
  const value = req.user?.id;
  if (!value) throw new Error('authentication required');
  return value;
}

function routeId(req: express.Request, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function continueRequest(value: unknown): ContinueAgentRunRequestV1 {
  const raw = object(value);
  if (raw.version !== 1 || typeof raw.workspaceId !== 'string' || !raw.workspaceId.trim()) throw new Error('invalid Continue request');
  for (const key of ['includeTask', 'includeResult', 'includeTranscript'] as const) {
    if (typeof raw[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  if (raw.fallback !== 'error' && raw.fallback !== 'new_thread') throw new Error('fallback must be error or new_thread');
  return { version: 1, workspaceId: raw.workspaceId.trim(), includeTask: raw.includeTask,
    includeResult: raw.includeResult, includeTranscript: raw.includeTranscript, fallback: raw.fallback };
}

function saveRequest(value: unknown): SaveAgentRunAsDefinitionRequestV1 {
  const raw = object(value);
  if (raw.version !== 1 || typeof raw.workspaceId !== 'string' || !raw.workspaceId.trim()) throw new Error('invalid Save request');
  if (raw.name !== undefined && typeof raw.name !== 'string') throw new Error('name must be a string');
  return { version: 1, workspaceId: raw.workspaceId.trim(), ...(typeof raw.name === 'string' ? { name: raw.name } : {}) };
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be an object');
  return value as Record<string, any>;
}

function sendError(res: express.Response, error: unknown): void {
  if (error instanceof AgentRunActionError) {
    res.status(error.code === 'not_found' ? 404 : 400).json({ error: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'invalid request';
  res.status(/reused with a different payload/.test(message) ? 409 : /authentication required/.test(message) ? 401 : 400)
    .json({ error: message });
}

export function mountAgentRunActionRoutes(router: express.Router, deps: AgentRunActionRouteDeps): void {
  router.post('/agent-runs/:runId/continue-as-branch', async (req, res) => {
    try {
      const result = deps.actions.continueAsBranch(owner(req), routeId(req, 'runId'), continueRequest(req.body), deps.operationId(req));
      res.status(201).json(result);
    } catch (error) { sendError(res, error); }
  });
  router.post('/agent-runs/:runId/save-as-agent', async (req, res) => {
    try {
      const result = await deps.actions.saveAsAgent(owner(req), routeId(req, 'runId'), saveRequest(req.body), deps.operationId(req));
      res.status(201).json(result);
    } catch (error) { sendError(res, error); }
  });
}
