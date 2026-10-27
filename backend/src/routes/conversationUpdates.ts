import { Router } from 'express';
import { ConversationUpdatesError } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { readConversationUpdates } from '../services/conversationUpdates';

export function setupConversationUpdatesRoutes(): Router {
  const router = Router();
  router.get('/workspaces/:workspaceId/conversation-updates', (req, res) => {
    try {
      const number = (key: string): number | undefined => {
        const value = req.query[key];
        if (value === undefined) return undefined;
        if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new ConversationUpdatesError('invalid_argument', `${key} must be an integer`);
        return Number(value);
      };
      const include = req.query.includeMessages;
      if (include !== undefined && include !== 'true' && include !== 'false') throw new ConversationUpdatesError('invalid_argument', 'includeMessages must be true or false');
      const result = readConversationUpdates({
        ownerUserId: process.env.MICHI_CLOUD === '1' ? req.user?.id ?? '' : LOCAL_AGENT_OWNER_ID,
        workspaceId: req.params.workspaceId as string, backendConnectionId: 'local',
      }, { after: number('after'), through: number('through'), limit: number('limit'), includeMessages: include === 'true' });
      res.json(result);
    } catch (error) {
      if (error instanceof ConversationUpdatesError) {
        res.status(error.code === 'not_found' ? 404 : error.code === 'navigation_disabled' ? 403 : 400).json({ code: error.code, message: error.message });
      } else {
        res.status(500).json({ code: 'internal_error', message: 'Could not read conversation updates' });
      }
    }
  });
  return router;
}
