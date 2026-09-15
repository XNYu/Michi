import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// An isolated HTTP/1.1 gateway using the real transport and frontend clients.
// No Michi data, SQLite, credentials, agent processes or installed app needed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(tmpdir(), 'michi-stream-transport-'));
let browser;
let server;
let transport;
try {
  const backendBundle = path.join(temp, 'transport.cjs');
  await build({ entryPoints: [path.join(root, 'backend/src/services/streamTransport.ts')], outfile: backendBundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  const { createStreamTransport } = createRequire(import.meta.url)(backendBundle);
  const frontend = await build({
    stdin: { contents: `
      export { streamMessage, subscribeBackground } from './frontend/src/services/api/stream';
      export { fetchStream } from './frontend/src/services/api/streamTransport';
      export { fetchArtifactContent } from './frontend/src/services/api/artifacts';
      export { fetchTreeMessages, fetchPersistenceCapabilities } from './frontend/src/services/api/persistence';
      export { importWorkspaceFileBinary } from './frontend/src/services/api/uploads';
    `, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'michi',
    define: { 'import.meta.env.VITE_API_URL': '"/api"', 'import.meta.env.DEV': 'false' },
  });
  const app = express();
  app.use(express.json());
  transport = createStreamTransport();
  app.use('/api', transport.router);
  const held = new Map();
  let socketCount = 0;
  let ordinaryRequests = 0;
  app.get('/', (_req, res) => res.type('html').send('<!doctype html><title>Michi transport regression</title><style>body{font:16px system-ui;margin:48px;color:#20242b;background:#fff}h1{font-size:26px}pre{font:15px monospace;line-height:1.8;white-space:pre-wrap}</style><h1>Michi transport regression</h1><pre id="result">Running isolated transport checks...</pre>'));
  app.get('/bundle.js', (_req, res) => res.type('js').send(frontend.outputFiles[0].text));
  app.all('/api/*route', async (req, res) => {
    if (req.path.endsWith('/message') || req.path.endsWith('/background/subscribe') || req.path.endsWith('/stream') || req.path.endsWith('/agent-runs/subscribe') || req.path.endsWith('/panes/subscribe')) {
      held.set(req.originalUrl, res);
      res.on('close', () => held.delete(req.originalUrl));
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(': connected\n\n');
    } else if (req.path.endsWith('/persistence/capabilities')) {
      res.json({ protocolVersion: 2, streamTransport: 'websocket-v1' });
    } else if (req.path.includes('/artifacts/')) {
      ordinaryRequests++;
      const content = await readFile(path.join(root, 'package.json'), 'utf8');
      res.json({ content, extension: 'json', size: content.length, modifiedAt: Date.now() });
    } else if (req.path.endsWith('/messages')) {
      ordinaryRequests++;
      res.json({ messages: [] });
    } else if (req.path.endsWith('/import-file')) {
      ordinaryRequests++;
      await writeFile(path.join(temp, 'upload.png'), Buffer.from(req.body.contentBase64, 'base64'));
      res.json({ name: 'upload.png', filePath: '.attachments/upload.png', size: 3 });
    } else res.json({ ok: true });
  });
  server = app.listen(0, '127.0.0.1');
  transport.attach(server);
  server.on('upgrade', () => { socketCount++; });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1040, height: 620 } });
  await page.goto(base);
  await page.addScriptTag({ url: `${base}/bundle.js` });

  async function waitUntil(predicate) {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(predicate(), 'server condition did not settle');
  }
  async function startOrdinaryRequests() {
    await page.evaluate(() => {
      window.completed = {};
      const started = performance.now();
      const track = (name, work) => work.then(() => { window.completed[name] = Math.round(performance.now() - started); });
      window.ordinary = Promise.all([
        track('File read', michi.fetchArtifactContent('test', '.contexts/test.md')),
        track('History load', michi.fetchTreeMessages('test', 'tree')),
        track('Image upload', michi.importWorkspaceFileBinary('test', '/mock', 'upload.png', new Uint8Array([1, 2, 3]), { onProgress() {} })),
      ]);
    });
  }

  await page.evaluate(async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => fetch(`/api/chats/legacy-${i}/stream`)));
  });
  assert.equal(held.size, 6);
  await startOrdinaryRequests();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(ordinaryRequests, 0, 'legacy requests should still be queued in Chromium');
  assert.deepEqual(await page.evaluate(() => window.completed), {});
  for (const response of held.values()) response.end();
  await page.waitForFunction(() => Object.keys(window.completed).length === 3);
  await waitUntil(() => held.size === 0);

  await page.evaluate(async () => {
    await michi.fetchPersistenceCapabilities();
    window.cancels = [];
    for (let i = 0; i < 24; i++) window.cancels.push(michi.streamMessage(`chat-${i}`, 'isolated fixture', {}));
    window.cancels.push(michi.subscribeBackground(() => ({})));
    window.cancels.push(michi.subscribeBackground(() => ({}), {}, 'remote-fixture'));
    await Promise.all([
      michi.fetchStream('/api/workspaces/test/watch/stream'),
      michi.fetchStream('/api/agent-runs/subscribe?workspaceId=test'),
      michi.fetchStream('/api/digests/stream', { method: 'POST', body: '{}' }),
      michi.fetchStream('/api/panes/subscribe?paneIds=%5B%22node%3An-1%22%5D'),
    ]);
  });
  await waitUntil(() => held.size === 30);
  assert.equal(socketCount, 1, 'all 30 streams must use one WebSocket');
  await startOrdinaryRequests();
  await page.waitForFunction(() => Object.keys(window.completed).length === 3, null, { timeout: 3_000 });
  const timings = await page.evaluate(() => window.completed);
  assert.ok(Object.values(timings).every((ms) => ms < 1_500));
  assert.equal(held.size, 30, 'ordinary requests must complete while every stream remains active');
  assert.deepEqual(await readFile(path.join(temp, 'upload.png')), Buffer.from([1, 2, 3]));

  await page.evaluate(() => window.cancels[0]());
  await waitUntil(() => held.size === 29);
  const report = { status: 'PASS', legacyHttpStreams: 6, legacyQueuedRequests: 3,
    multiplexedStreams: 30, webSockets: socketCount, concurrentRequestMs: timings,
    cancellation: 'One channel detached; 28 remain active', isolation: 'Mock gateway; no user data or agent execution' };
  await page.locator('#result').evaluate((element, text) => { element.textContent = text; }, JSON.stringify(report, null, 2));
  if (process.env.MICHI_TRANSPORT_SCREENSHOT) {
    const screenshot = path.resolve(process.env.MICHI_TRANSPORT_SCREENSHOT);
    await mkdir(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
  }
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  browser = undefined;
  await waitUntil(() => held.size === 0);
} finally {
  await browser?.close();
  transport?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
