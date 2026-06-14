import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setupFilesRoutes } from '../src/routes/files';
import { SHOW_IMAGE_MAX_BYTES } from '../src/agents/claude/showImage';
import { closeDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';

// Mirror agentStatusRoute.test.ts: build a real express app, listen on an
// ephemeral port, and exercise the route with fetch(). No supertest dep.
// resolveRoot is injected so the test never depends on cloud/desktop cwd
// resolution — it just points the route at a tmp dir.

function tmpRoot(prefix = 'files-'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function appWithRoot(root: string): express.Express {
    const app = express();
    app.use('/api', setupFilesRoutes({ resolveRoot: () => root }));
    return app;
}

async function withServer(
    app: express.Express,
    fn: (port: number) => Promise<void>,
): Promise<void> {
    const server = app.listen(0);
    try {
        const port = (server.address() as { port: number }).port;
        await fn(port);
    } finally {
        server.close();
    }
}

describe('GET /api/files/:workspaceId/*', () => {
    test('serves a real png with image/png + nosniff headers', async () => {
        const root = tmpRoot();
        fs.writeFileSync(path.join(root, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/a.png`);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-type'), 'image/png');
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
            assert.equal(res.headers.get('content-disposition'), 'inline');
            assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
            const body = Buffer.from(await res.arrayBuffer());
            assert.deepEqual([...body], [0x89, 0x50, 0x4e, 0x47]);
        });
    });

    test('serves a nested png', async () => {
        const root = tmpRoot();
        fs.mkdirSync(path.join(root, 'sub', 'dir'), { recursive: true });
        fs.writeFileSync(path.join(root, 'sub', 'dir', 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/sub/dir/b.jpg`);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-type'), 'image/jpeg');
            // drain so the socket closes cleanly
            await res.arrayBuffer();
        });
    });

    test('404 on path traversal', async () => {
        const root = tmpRoot();
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/..%2f..%2fetc%2fhosts`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 on non-image extension', async () => {
        const root = tmpRoot();
        fs.writeFileSync(path.join(root, 'a.txt'), 'x');
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/a.txt`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 on svg (excluded from allowlist)', async () => {
        const root = tmpRoot();
        fs.writeFileSync(path.join(root, 'x.svg'), '<svg/>');
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/x.svg`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 on missing file', async () => {
        const root = tmpRoot();
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/missing.png`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 on bad workspaceId', async () => {
        const root = tmpRoot();
        fs.writeFileSync(path.join(root, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        await withServer(appWithRoot(root), async (port) => {
            // "!" is outside [a-zA-Z0-9_-]
            const res = await fetch(`http://127.0.0.1:${port}/api/files/bad%21id/a.png`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 on directory (no listing)', async () => {
        const root = tmpRoot();
        fs.mkdirSync(path.join(root, 'adir'), { recursive: true });
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/adir`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 on symlink escape (file symlinked from outside the root)', async () => {
        const root = tmpRoot();
        // A secret living OUTSIDE the workspace root, named with an image ext
        // so only the realpath re-assertion (not the MIME check) can reject it.
        const outside = tmpRoot('files-outside-');
        const secret = path.join(outside, 'secret.png');
        fs.writeFileSync(secret, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        // Symlink it INTO the workspace root. resolveWithinCwd passes (the link
        // path is inside cwd) but realpathSync resolves outside → must 404.
        const link = path.join(root, 'link.png');
        fs.symlinkSync(secret, link);
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/link.png`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    // ── Escape-vector regression tests ───────────────────────────────────────
    // These pin the security contract at the segment-guard layer. Previously
    // they 404'd only by luck of assertWithinCwd downstream; now the route
    // rejects them up front, independent of that LLM-path helper's semantics.

    test('404 on absolute-path escape via empty leading segment (//etc/passwd)', async () => {
        // path-to-regexp splits "//etc/passwd" → ["", "etc", "passwd"]; the
        // empty leading segment is the signature of a "//" (would otherwise
        // resolve absolute). The segment guard must reject the empty segment.
        const root = tmpRoot();
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1//etc/passwd`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 on tilde escape (~ segment)', async () => {
        // expandPath in resolveWithinCwd would expand "~" to $HOME — the route
        // must reject a "~"-leading segment before it ever reaches that helper.
        const root = tmpRoot();
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/~/secret.png`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 on double-encoded traversal (%252e%252e) — pins the single-decode contract', async () => {
        // path-to-regexp decodes ONCE → "%2e%2e/secret.png" (a literal, harmless
        // segment). If anyone adds a second decodeURIComponent, this becomes
        // "../secret.png" and escapes — this test breaks first.
        const root = tmpRoot();
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/%252e%252e%2fsecret.png`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('serves uppercase extension (A.PNG → 200) — guards .toLowerCase()', async () => {
        const root = tmpRoot();
        fs.writeFileSync(path.join(root, 'A.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/A.PNG`);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-type'), 'image/png');
            await res.arrayBuffer();
        });
    });

    test('404 on an image over the size cap', async () => {
        const root = tmpRoot();
        // One byte over the cap — a valid png ext, so only the size check rejects it.
        fs.writeFileSync(path.join(root, 'big.png'), Buffer.alloc(SHOW_IMAGE_MAX_BYTES + 1));
        await withServer(appWithRoot(root), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/ws1/big.png`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });
});

// Desktop cwd resolution via the REAL default resolver (no resolveRoot
// injection): the route must serve from the persisted workspaces.cwd — the
// canonical session cwd the frontend syncs — so an Electron user-picked folder
// works, falling back to the upload root only when no cwd is stored.
describe('GET /api/files (desktop cwd resolution via persisted workspaces.cwd)', () => {
    let dataDir: string;
    let prevDataDir: string | undefined;

    beforeEach(() => {
        prevDataDir = process.env.MICHI_DATA_DIR;
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-datadir-'));
        process.env.MICHI_DATA_DIR = dataDir;
        delete process.env.MICHI_CLOUD; // exercise the desktop branch
        closeDb(); // next getDb() opens dataDir/data.db
    });

    afterEach(() => {
        closeDb();
        if (prevDataDir === undefined) delete process.env.MICHI_DATA_DIR;
        else process.env.MICHI_DATA_DIR = prevDataDir;
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    function realApp(): express.Express {
        const app = express();
        app.use('/api', setupFilesRoutes()); // real defaultResolveRoot
        return app;
    }

    test('serves an image from a user-picked folder recorded in workspaces.cwd', async () => {
        // An arbitrary absolute folder (the "Electron picked folder" case).
        const picked = fs.mkdtempSync(path.join(os.tmpdir(), 'picked-folder-'));
        fs.mkdirSync(path.join(picked, '.contexts'), { recursive: true });
        fs.writeFileSync(path.join(picked, '.contexts', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const now = Date.now();
        saveWorkspace({ id: 'wsdesk', name: 'Picked', cwd: picked, created_at: now, updated_at: now });

        await withServer(realApp(), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/wsdesk/.contexts/shot.png`);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-type'), 'image/png');
            await res.arrayBuffer();
        });
        fs.rmSync(picked, { recursive: true, force: true });
    });

    test('still sandboxes: traversal out of the picked folder is 404', async () => {
        const picked = fs.mkdtempSync(path.join(os.tmpdir(), 'picked-folder-'));
        const now = Date.now();
        saveWorkspace({ id: 'wsdesk2', name: 'Picked', cwd: picked, created_at: now, updated_at: now });
        await withServer(realApp(), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/wsdesk2/..%2f..%2fetc%2fhosts`);
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
        fs.rmSync(picked, { recursive: true, force: true });
    });

    test('falls back to the upload root when workspaces.cwd is unset', async () => {
        // No workspace row → stored cwd is absent → resolver uses the upload
        // root <tmpdir>/michi/files/<id>. Serve a file placed there.
        const uploadRoot = path.join(os.tmpdir(), 'michi', 'files', 'wsfallback');
        fs.mkdirSync(uploadRoot, { recursive: true });
        fs.writeFileSync(path.join(uploadRoot, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        await withServer(realApp(), async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/files/wsfallback/a.png`);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-type'), 'image/png');
            await res.arrayBuffer();
        });
        fs.rmSync(uploadRoot, { recursive: true, force: true });
    });
});
