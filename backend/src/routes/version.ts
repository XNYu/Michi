import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { requireAdmin } from './middleware/admin';
import { recordAudit } from '../services/audit';

const execFileAsync = promisify(execFile);

let cachedRemote: { hash: string; remoteName: string; branch: string; checkedAt: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: process.cwd() });
  return stdout.trim();
}

async function gitMaybe(...args: string[]): Promise<string | null> {
  try { return await git(...args); } catch { return null; }
}

// Update & Restart strictly tracks `amazon/dev` — the Michi internal release
// branch. If the user has no `amazon` remote (or `amazon/dev` does not exist),
// we return null so the button stays hidden rather than fall back to whatever
// remote happens to be configured.
async function pickUpstream(): Promise<{ remote: string; branch: string } | null> {
  const remotesOut = await gitMaybe('remote');
  if (!remotesOut) return null;
  const remotes = remotesOut.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!remotes.includes('amazon')) return null;
  const verified = await gitMaybe('rev-parse', '--verify', 'refs/remotes/amazon/dev');
  if (!verified) return null;
  return { remote: 'amazon', branch: 'amazon/dev' };
}

export function setupVersionRoutes(): Router {
  const router = Router();

  router.get('/version', async (_req, res) => {
    try {
      const localHash = await git('rev-parse', '--short', 'HEAD');
      const localDate = await git('log', '-1', '--format=%ci');

      let remoteHash: string | null = null;
      let remoteName: string | null = null;
      let updateAvailable = false;

      try {
        const upstream = await pickUpstream();
        if (upstream) {
          remoteName = upstream.remote;
          if (
            cachedRemote &&
            cachedRemote.branch === upstream.branch &&
            Date.now() - cachedRemote.checkedAt < CACHE_TTL
          ) {
            remoteHash = cachedRemote.hash;
          } else {
            const lsRemote = await git('ls-remote', upstream.remote, 'HEAD');
            const fullHash = lsRemote.split('\t')[0] || null;
            if (fullHash) {
              remoteHash = fullHash.substring(0, 7);
              cachedRemote = {
                hash: remoteHash,
                remoteName: upstream.remote,
                branch: upstream.branch,
                checkedAt: Date.now(),
              };
            }
          }
          // updateAvailable iff upstream has commits HEAD doesn't have (strictly behind or diverged).
          // Pure "ahead" should NOT show the badge.
          if (remoteHash) {
            const count = await gitMaybe('rev-list', '--count', `HEAD..${upstream.branch}`);
            updateAvailable = count !== null && parseInt(count, 10) > 0;
          }
        }
      } catch {
        // offline or no remote — skip
      }

      res.json({ localHash, localDate, remoteHash, remoteName, updateAvailable });
    } catch {
      res.status(500).json({ error: 'Not a git repository' });
    }
  });

  router.post('/version/update', requireAdmin, async (req, res) => {
    const force = req.body?.force === true;
    try {
      const upstream = await pickUpstream();
      if (!upstream) {
        return res.status(400).json({ ok: false, error: 'No remote configured' });
      }

      // Fetch first so ahead/behind reflects the latest tip.
      await git('fetch', upstream.remote, '--quiet');

      // Safety 1: refuse if HEAD has commits not on upstream (silent loss of work; check first
      // because "ahead" is the more dangerous of the two warnings).
      const aheadCountStr = await git('rev-list', '--count', `${upstream.branch}..HEAD`);
      const aheadCount = parseInt(aheadCountStr, 10) || 0;
      if (aheadCount > 0 && !force) {
        return res.status(409).json({
          ok: false,
          error: `${aheadCount} local commit(s) ahead of ${upstream.branch} would be lost.`,
          requiresConfirm: true,
          reason: 'ahead',
          aheadCount,
          remoteName: upstream.remote,
          branch: upstream.branch,
        });
      }

      // Safety 2: refuse if tracked files have uncommitted changes (untracked files survive reset).
      const dirty = await git('status', '--porcelain', '--untracked-files=no');
      if (dirty && !force) {
        return res.status(409).json({
          ok: false,
          error: `Uncommitted changes in tracked files would be discarded by reset.`,
          requiresConfirm: true,
          reason: 'dirty',
          remoteName: upstream.remote,
          branch: upstream.branch,
        });
      }

      // Safety 3: always snapshot HEAD so the prior tip is recoverable by ref name (not just reflog).
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupRef = `refs/michi/pre-update/${ts}`;
      const headSha = await git('rev-parse', 'HEAD');
      await git('update-ref', backupRef, headSha);

      await git('reset', '--hard', upstream.branch);

      const npmExec = promisify(require('child_process').execFile);
      await npmExec('npm', ['install', '--no-fund', '--no-audit', '--loglevel=error'], {
        cwd: process.cwd(),
      });
      cachedRemote = null;
      const newHash = await git('rev-parse', '--short', 'HEAD');
      recordAudit({
        action: 'admin.version.update',
        actor: { id: req.user?.id ?? null, email: req.user?.email ?? null },
        ip: ((req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()) ?? req.ip ?? null,
        ua: req.headers['user-agent'] ?? null,
        metadata: { newHash, backupRef, branch: upstream.branch },
      });
      res.json({
        ok: true,
        newHash,
        backupRef,
        remoteName: upstream.remote,
        branch: upstream.branch,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  return router;
}
