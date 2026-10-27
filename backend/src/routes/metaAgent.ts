import { Router } from 'express';
import type { Response } from 'express';
import type { MetaAgentSettingsPatch, MetaAgentToolset } from 'michi-shared';
import { localOnlyGuard } from './middleware/localOnly';
import { log } from '../services/logger';
import { META_AGENT_TOOLSETS, retryMetaAgentGuard } from '../services/metaAgent/guardStatus';
import { MetaAgentSettingsError, metaAgentInfo, updateMetaAgentSettings } from '../services/metaAgent/settings';

/** The Meta agent reads every workspace: like the assistant, only this machine's own app may configure it. */
const metaAgentLocalOnly = localOnlyGuard('The Meta agent is local-only');

const FIELDS = ['runtimeId', 'providerId', 'modelId', 'reasoning', 'writeWorkspaceHomes', 'maintainSpacesHome', 'firstRunDays'] as const;

function settingsPatch(body: unknown): MetaAgentSettingsPatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new MetaAgentSettingsError('body must be an object');
  const unknown = Object.keys(body).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new MetaAgentSettingsError(`unknown field: ${unknown[0]}`);
  const record = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of FIELDS) if (key in record) patch[key] = record[key];
  return patch as MetaAgentSettingsPatch;
}

/** An empty body (or none) retries both toolsets. */
function retryToolsets(body: unknown): readonly MetaAgentToolset[] {
  if (body === undefined || body === null) return META_AGENT_TOOLSETS;
  if (typeof body !== 'object' || Array.isArray(body)) throw new MetaAgentSettingsError('body must be an object');
  const unknown = Object.keys(body).filter((key) => key !== 'toolset');
  if (unknown.length > 0) throw new MetaAgentSettingsError(`unknown field: ${unknown[0]}`);
  const { toolset } = body as { toolset?: unknown };
  if (toolset === undefined) return META_AGENT_TOOLSETS;
  if (!(META_AGENT_TOOLSETS as readonly unknown[]).includes(toolset)) throw new MetaAgentSettingsError('toolset must be maintenance or chat');
  return [toolset as MetaAgentToolset];
}

/**
 * The Meta agent's one settings record (services/metaAgent/settings.ts) and
 * its restriction check results (services/metaAgent/guardStatus.ts).
 * Local-only; never mounted in cloud mode or on a remotely exposed backend.
 *
 *   GET /api/meta-agent           → MetaAgentInfo
 *   PUT /api/meta-agent/settings  {runtimeId?, providerId?, modelId?, reasoning?,
 *                                  writeWorkspaceHomes?, maintainSpacesHome?, firstRunDays?} → MetaAgentInfo
 *                                 null follows the global settings (or the default); omitted keeps the value
 *   POST /api/meta-agent/retry    {toolset?} → MetaAgentInfo
 *                                 clears the stored check (both toolsets when omitted); a
 *                                 cleared maintenance check starts one maintenance run now
 */
export function setupMetaAgentRoutes(): Router {
  const router = Router();
  router.use('/meta-agent', ...metaAgentLocalOnly);

  const fail = (res: Response, err: unknown, what: string) => {
    if (err instanceof MetaAgentSettingsError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.warn('http', `meta agent ${what} failed`, { err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'The Meta agent settings are not available' });
  };

  router.get('/meta-agent', (_req, res) => {
    try {
      res.json(metaAgentInfo());
    } catch (err) {
      fail(res, err, 'read');
    }
  });

  router.put('/meta-agent/settings', (req, res) => {
    try {
      updateMetaAgentSettings(settingsPatch(req.body));
      res.json(metaAgentInfo());
    } catch (err) {
      fail(res, err, 'settings update');
    }
  });

  router.post('/meta-agent/retry', (req, res) => {
    try {
      retryMetaAgentGuard(retryToolsets(req.body));
      res.json(metaAgentInfo());
    } catch (err) {
      fail(res, err, 'retry');
    }
  });

  return router;
}
