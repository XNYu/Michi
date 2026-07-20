import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupDiffRoutes } from '../src/routes/diff';
import { NotFoundError } from '../src/agents/tools/pathSandbox';

// Mirror files.test.ts: real express app on an ephemeral port, resolveCwd
// injected so the route never touches the DB or cloud sandbox resolution.

function tmpRoot(prefix = 'diff-'): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function gitInit(cwd: string): void {
    const run = (args: string[]) =>
        execFileSync('git', args, { cwd, stdio: 'ignore' });
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    run(['config', 'commit.gpgsign', 'false']);
}

function gitCommitAll(cwd: string, message: string): void {
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd, stdio: 'ignore' });
}

function appWithCwd(cwd: string): express.Express {
    const app = express();
    app.use('/api', setupDiffRoutes({
        resolveCwd: (_req, workspaceId) => {
            if (workspaceId !== 'ws1') throw new NotFoundError(workspaceId);
            return cwd;
        },
    }));
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

describe('GET /api/workspaces/:workspaceId/diff', () => {
    test('returns unified diff for an uncommitted change', async () => {
        const root = tmpRoot();
        gitInit(root);
        fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
        gitCommitAll(root, 'init');
        fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\nthree\n');

        await withServer(appWithCwd(root), async (port) => {
            const res = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/ws1/diff?path=a.txt`,
            );
            assert.equal(res.status, 200);
            const body = await res.json() as { diff: string; truncated: boolean };
            assert.match(body.diff, /^diff --git/m);
            assert.match(body.diff, /\+TWO/);
            assert.match(body.diff, /-two/);
            assert.equal(body.truncated, false);
        });
    });

    test('returns synthesized new-file diff for an untracked file', async () => {
        const root = tmpRoot();
        gitInit(root);
        fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
        gitCommitAll(root, 'init');
        fs.writeFileSync(path.join(root, 'brand-new.ts'), 'const x = 1;\n');

        await withServer(appWithCwd(root), async (port) => {
            const res = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/ws1/diff?path=brand-new.ts`,
            );
            assert.equal(res.status, 200);
            const body = await res.json() as { diff: string };
            assert.match(body.diff, /\+const x = 1;/);
        });
    });

    test('falls back to the last commit when the working tree is clean', async () => {
        const root = tmpRoot();
        gitInit(root);
        fs.writeFileSync(path.join(root, 'b.txt'), 'v1\n');
        gitCommitAll(root, 'first');
        fs.writeFileSync(path.join(root, 'b.txt'), 'v2\n');
        gitCommitAll(root, 'second');

        await withServer(appWithCwd(root), async (port) => {
            const res = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/ws1/diff?path=b.txt`,
            );
            assert.equal(res.status, 200);
            const body = await res.json() as { diff: string };
            assert.match(body.diff, /\+v2/);
            assert.match(body.diff, /-v1/);
        });
    });

    test('404 on path traversal', async () => {
        const root = tmpRoot();
        gitInit(root);
        await withServer(appWithCwd(root), async (port) => {
            const res = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/ws1/diff?path=${encodeURIComponent('../../etc/passwd')}`,
            );
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 on tilde-prefixed path', async () => {
        const root = tmpRoot();
        gitInit(root);
        await withServer(appWithCwd(root), async (port) => {
            const res = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/ws1/diff?path=${encodeURIComponent('~/secret')}`,
            );
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 on git pathspec magic — cannot reach repo files outside the workspace cwd', async () => {
        // Workspace cwd is a SUBDIRECTORY of a larger repo. ':/secret.txt'
        // resolves lexically inside cwd, but git would interpret the ':'
        // pathspec magic relative to the REPO ROOT — leaking secret.txt.
        const repoRoot = tmpRoot();
        gitInit(repoRoot);
        const sub = path.join(repoRoot, 'workspace');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(repoRoot, 'secret.txt'), 'top secret v1\n');
        fs.writeFileSync(path.join(sub, 'inner.txt'), 'inner\n');
        gitCommitAll(repoRoot, 'init');
        fs.writeFileSync(path.join(repoRoot, 'secret.txt'), 'top secret v2\n');

        await withServer(appWithCwd(sub), async (port) => {
            for (const hostile of [':/secret.txt', ':(top)secret.txt']) {
                const res = await fetch(
                    `http://127.0.0.1:${port}/api/workspaces/ws1/diff?path=${encodeURIComponent(hostile)}`,
                );
                assert.equal(res.status, 404, `expected 404 for ${hostile}`);
                await res.arrayBuffer();
            }
            // Sanity: normal subdir file still diffs fine.
            fs.writeFileSync(path.join(sub, 'inner.txt'), 'inner changed\n');
            const ok = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/ws1/diff?path=inner.txt`,
            );
            assert.equal(ok.status, 200);
            const body = await ok.json() as { diff: string };
            assert.match(body.diff, /\+inner changed/);
        });
    });

    test('400 when path param is missing', async () => {
        const root = tmpRoot();
        gitInit(root);
        await withServer(appWithCwd(root), async (port) => {
            const res = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/ws1/diff`,
            );
            assert.equal(res.status, 400);
            await res.arrayBuffer();
        });
    });

    test('404 when workspace is unknown', async () => {
        const root = tmpRoot();
        gitInit(root);
        await withServer(appWithCwd(root), async (port) => {
            const res = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/nope/diff?path=a.txt`,
            );
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 when cwd is not a git repository', async () => {
        const root = tmpRoot();
        fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
        await withServer(appWithCwd(root), async (port) => {
            const res = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/ws1/diff?path=a.txt`,
            );
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('404 when the file has no diff', async () => {
        const root = tmpRoot();
        gitInit(root);
        fs.writeFileSync(path.join(root, 'clean.txt'), 'stable\n');
        gitCommitAll(root, 'first');
        // Second commit touching a DIFFERENT file so HEAD~1 exists but
        // clean.txt has no delta anywhere.
        fs.writeFileSync(path.join(root, 'other.txt'), 'x\n');
        gitCommitAll(root, 'second');

        await withServer(appWithCwd(root), async (port) => {
            const res = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/ws1/diff?path=clean.txt`,
            );
            assert.equal(res.status, 404);
            await res.arrayBuffer();
        });
    });

    test('truncates diffs larger than 100KB', async () => {
        const root = tmpRoot();
        gitInit(root);
        fs.writeFileSync(path.join(root, 'big.txt'), 'seed\n');
        gitCommitAll(root, 'init');
        const big = Array.from({ length: 20_000 }, (_, i) => `line ${i} xxxxxxxxxx`).join('\n');
        fs.writeFileSync(path.join(root, 'big.txt'), big);

        await withServer(appWithCwd(root), async (port) => {
            const res = await fetch(
                `http://127.0.0.1:${port}/api/workspaces/ws1/diff?path=big.txt`,
            );
            assert.equal(res.status, 200);
            const body = await res.json() as { diff: string; truncated: boolean };
            assert.equal(body.truncated, true);
            assert.ok(Buffer.byteLength(body.diff, 'utf8') <= 100 * 1024);
        });
    });
});
