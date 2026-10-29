import { Router } from 'express';
import type { Request, Response } from 'express';
import type { MichiAssistantSettingsPatch } from 'michi-shared';
import { chatHub } from '../agents/chatHub';
import { getRuntime } from '../agents/registry';
import * as sessionRegistry from '../agents/sessionRegistry';
import {
  activateAssistantConversation,
  listAssistantConversations,
  AssistantSettingsError,
  ensureAssistant,
  ensureAssistantFor,
  resetAssistant,
  updateAssistantSettings,
  type AssistantPurpose,
} from '../assistant/store';
import { localOnlyGuard } from './middleware/localOnly';
import { log } from '../services/logger';

/** The assistant reads every workspace: only the local app or authenticated remote owner may reach it. */
const assistantLocalOnly = localOnlyGuard('The Michi assistant requires local or authenticated remote access', { allowAuthenticatedRemote: true });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only the known fields reach the store; anything else is refused. */
function settingsPatch(body: unknown): MichiAssistantSettingsPatch {
  if (!isObject(body)) throw new AssistantSettingsError('body must be an object');
  const unknown = Object.keys(body).filter((key) => !['nodeId', 'runtimeId', 'providerId', 'modelId', 'reasoning'].includes(key));
  if (unknown.length > 0) throw new AssistantSettingsError(`unknown field: ${unknown[0]}`);
  const patch: MichiAssistantSettingsPatch = {};
  if ('nodeId' in body) {
    if (typeof body.nodeId !== 'string' || !body.nodeId || body.nodeId.length > 160) throw new AssistantSettingsError('nodeId must be an assistant conversation id');
    patch.nodeId = body.nodeId;
  }
  if ('runtimeId' in body) patch.runtimeId = body.runtimeId as string;
  if ('providerId' in body) patch.providerId = body.providerId as string | null;
  if ('modelId' in body) patch.modelId = body.modelId as string | null;
  if ('reasoning' in body) patch.reasoning = body.reasoning as MichiAssistantSettingsPatch['reasoning'];
  return patch;
}

/**
 * The Michi assistant: one persistent conversation in a hidden system
 * workspace (assistant/store.ts). Available locally and to the authenticated remote owner; never mounted in cloud mode.
 *
 *   GET  /api/assistant           → MichiAssistantInfo (creates it on first use)
 *   PUT  /api/assistant/settings  {nodeId?, runtimeId?, providerId?, modelId?, reasoning?} → MichiAssistantInfo
 *                                 (what the user picked in that conversation, the current one by default)
 *   POST /api/assistant/reset     {nodeId?} → MichiAssistantInfo of a fresh conversation (the old one is archived)
 *                                 409 assistant_busy while it answers; 409 assistant_changed (with `current`)
 *                                 when `nodeId` is given and is no longer the current conversation
 *   GET  /api/assistant/schedule        → MichiAssistantInfo of the Scheduled window's conversation
 *   POST /api/assistant/schedule/reset  {nodeId?} → as /reset, for that conversation only
 *
 * PUT /settings takes a Scheduled conversation's nodeId too and answers with that window's info.
 */
export function setupAssistantRoutes(): Router {
  const router = Router();
  router.use('/assistant', ...assistantLocalOnly);

  const fail = (res: Response, err: unknown, what: string) => {
    if (err instanceof AssistantSettingsError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.warn('http', `assistant ${what} failed`, { err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'The Michi assistant is not available' });
  };

  router.get('/assistant', (_req, res) => {
    try {
      res.json(ensureAssistant());
    } catch (err) {
      fail(res, err, 'provisioning');
    }
  });

  router.put('/assistant/settings', (req, res) => {
    try {
      res.json(updateAssistantSettings(settingsPatch(req.body)));
    } catch (err) {
      fail(res, err, 'settings update');
    }
  });

  router.get('/assistant/conversations', (req, res) => {
    try {
      if (req.query.cursor !== undefined && (typeof req.query.cursor !== 'string' || req.query.cursor.length > 512)) throw new AssistantSettingsError('Invalid conversation cursor');
      res.json(listAssistantConversations(req.query.limit === undefined ? 5 : Number(req.query.limit), req.query.cursor as string | undefined));
    } catch (err) { fail(res, err, 'history'); }
  });

  router.post('/assistant/conversations/:nodeId/activate', (req, res) => {
    try {
      const current = ensureAssistant();
      const expected = isObject(req.body) ? req.body.currentNodeId : undefined;
      if (expected !== current.nodeId) {
        res.status(409).json({ error: 'The assistant conversation changed. Try again.', code: 'assistant_changed', current });
        return;
      }
      const busy = (id: string) => chatHub.isActive(id) || chatHub.isOwnerTurnActive(id) || chatHub.hasPendingSelfTurn(id);
      if (busy(current.nodeId) || busy(req.params.nodeId)) {
        res.status(409).json({ error: 'The assistant is still answering', code: 'assistant_busy' });
        return;
      }
      res.json(activateAssistantConversation(req.params.nodeId));
    } catch (err) { fail(res, err, 'conversation switch'); }
  });

  const reset = (purpose: AssistantPurpose) => async (req: Request, res: Response) => {
    try {
      const expected = isObject(req.body) ? req.body.nodeId : undefined;
      if (expected !== undefined && (typeof expected !== 'string' || !expected || expected.length > 160)) {
        res.status(400).json({ error: 'nodeId must be the current conversation id' });
        return;
      }
      const current = ensureAssistantFor(purpose);
      // A client starting over a conversation it no longer shows (another
      // window already did) gets the current one instead of archiving it.
      if (expected !== undefined && expected !== current.nodeId) {
        res.status(409).json({ error: 'The assistant already started over', code: 'assistant_changed', current });
        return;
      }
      // Turn completion and runtime cleanup are separate: wait for both.
      if (chatHub.isActive(current.nodeId) || chatHub.isOwnerTurnActive(current.nodeId) || chatHub.hasPendingSelfTurn(current.nodeId)) {
        res.status(409).json({ error: 'The assistant is still answering', code: 'assistant_busy' });
        return;
      }
      const { info, previousNodeId } = resetAssistant(purpose);
      // The archived conversation keeps its history; its live runtime session is not needed.
      const live = sessionRegistry.getSession(previousNodeId);
      if (live) {
        await Promise.resolve(getRuntime(live.runtimeId)?.releaseSession(live.id)).catch(() => {});
        sessionRegistry.dropSession(live.id);
      }
      res.json(info);
    } catch (err) {
      fail(res, err, 'reset');
    }
  };

  router.post('/assistant/reset', reset('spaces'));

  // The Scheduled window's conversation: same workspace and settings, its own pointer and tools.
  router.get('/assistant/schedule', (_req, res) => {
    try {
      res.json(ensureAssistantFor('schedule'));
    } catch (err) {
      fail(res, err, 'provisioning');
    }
  });

  router.post('/assistant/schedule/reset', reset('schedule'));

  return router;
}
