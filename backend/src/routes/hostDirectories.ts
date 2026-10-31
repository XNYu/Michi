import express from 'express';
import { HOST_DIRECTORIES_PATH, HostDirectoryError, listHostDirectory } from '../services/hostDirectories';

/**
 * Folder browsing for a desktop that connects to this backend as a remote.
 * server.ts mounts it only when MICHI_REMOTE_ACCESS=1 (outside cloud mode),
 * where the remote-access middleware has already verified the bearer token.
 * The handler checks that verification again, so it fails closed if the
 * router is ever mounted without the token gate.
 */
export function setupHostDirectoryRoutes(): express.Router {
  const router = express.Router();
  router.get(HOST_DIRECTORIES_PATH, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (res.locals.remoteAccessAuthenticated !== true) {
      return res.status(403).json({ error: 'Remote access token required.' });
    }
    try {
      res.json(await listHostDirectory(typeof req.query.path === 'string' ? req.query.path : '~'));
    } catch (error) {
      if (error instanceof HostDirectoryError) return res.status(400).json({ error: error.message, code: error.code });
      res.status(500).json({ error: 'Could not read the folder.' });
    }
  });
  return router;
}
