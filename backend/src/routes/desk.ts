import express from 'express';
import {
  DeskAuthError,
  loadDeskNow,
  loadDeskPeek,
  loadDeskProject,
  loadDeskProjects,
  loadDeskResume,
  loadDeskThreads,
  markDeskLooked,
  mutateDeskThreads,
  projectScope,
  searchDeskThreads,
  undoDeskReceipt,
  type DeskMutation,
  type DeskScope,
} from '../services/desk';

function scopeFrom(req: express.Request): DeskScope {
  if (process.env.MICHI_CLOUD === '1') {
    const userId = req.user?.id;
    if (!userId) throw new DeskAuthError();
    return { userId, ownerKey: userId };
  }
  return { ownerKey: 'local' };
}

function param(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function parseSince(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function parseIds(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const ids = (body as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) return null;
  if (!ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)) return null;
  return ids;
}

function sendFailure(res: express.Response, err: unknown): void {
  if (err instanceof DeskAuthError) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  res.status(500).json({ error: 'desk_failed' });
}

export function setupDeskRoutes(): express.Router {
  const router = express.Router();

  router.get('/desk/now', (req, res) => {
    try {
      res.json(loadDeskNow(scopeFrom(req), parseSince(req.query.since)));
    } catch (err) {
      sendFailure(res, err);
    }
  });

  router.post('/desk/looked', (req, res) => {
    try {
      markDeskLooked(scopeFrom(req), 'now');
      res.json({ ok: true });
    } catch (err) {
      sendFailure(res, err);
    }
  });

  router.get('/desk/projects', (req, res) => {
    try {
      res.json({ projects: loadDeskProjects(scopeFrom(req)) });
    } catch (err) {
      sendFailure(res, err);
    }
  });

  router.get('/desk/projects/:id', (req, res) => {
    try {
      const view = loadDeskProject(scopeFrom(req), param(req.params.id), parseSince(req.query.since));
      if (!view) return res.status(404).json({ error: 'not_found' });
      res.json(view);
    } catch (err) {
      sendFailure(res, err);
    }
  });

  router.post('/desk/projects/:id/looked', (req, res) => {
    try {
      const scope = scopeFrom(req);
      const id = param(req.params.id);
      if (!loadDeskProject(scope, id, undefined)) return res.status(404).json({ error: 'not_found' });
      markDeskLooked(scope, projectScope(id));
      res.json({ ok: true });
    } catch (err) {
      sendFailure(res, err);
    }
  });

  router.get('/desk/threads', (req, res) => {
    try {
      res.json({ threads: loadDeskThreads(scopeFrom(req)) });
    } catch (err) {
      sendFailure(res, err);
    }
  });

  router.get('/desk/threads/search', (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!q || q.length > 200) return res.status(400).json({ error: 'query_required' });
      res.json({ threads: searchDeskThreads(scopeFrom(req), q) });
    } catch (err) {
      sendFailure(res, err);
    }
  });

  router.get('/desk/threads/:id/resume', (req, res) => {
    try {
      const resume = loadDeskResume(scopeFrom(req), param(req.params.id));
      if (!resume || resume.reason === 'bad-id') return res.status(404).json({ error: 'not_found' });
      res.json(resume);
    } catch (err) {
      sendFailure(res, err);
    }
  });

  router.get('/desk/threads/:id/peek', (req, res) => {
    try {
      const peek = loadDeskPeek(scopeFrom(req), param(req.params.id));
      if (!peek) return res.status(404).json({ error: 'not_found' });
      res.json(peek);
    } catch (err) {
      sendFailure(res, err);
    }
  });

  const mutate = (action: DeskMutation) => (req: express.Request, res: express.Response) => {
    try {
      const ids = parseIds(req.body);
      if (!ids) return res.status(400).json({ error: 'ids_required' });
      const write = mutateDeskThreads(scopeFrom(req), action, ids);
      if (!write) return res.status(404).json({ error: 'not_found' });
      res.json(write);
    } catch (err) {
      sendFailure(res, err);
    }
  };

  router.post('/desk/threads/archive', mutate('archive'));
  router.post('/desk/threads/ignore', mutate('ignore'));
  router.post('/desk/threads/unarchive', mutate('unarchive'));
  router.post('/desk/threads/unignore', mutate('unignore'));
  router.post('/desk/threads/done', mutate('done'));

  router.post('/desk/receipts/:id/undo', (req, res) => {
    try {
      const ok = undoDeskReceipt(scopeFrom(req), param(req.params.id));
      if (!ok) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true });
    } catch (err) {
      sendFailure(res, err);
    }
  });

  return router;
}
